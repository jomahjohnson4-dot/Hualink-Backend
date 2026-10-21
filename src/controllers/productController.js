import prisma from '../utils/prismaClient.js';
import { notifyAdmins } from '../services/notificationService.js';

/** The four languages a product description can be authored in. */
const DESCRIPTION_LANGUAGES = ['en', 'sw', 'zh', 'fr'];

/**
 * The `description` column is a plain TEXT column, but the admin form submits
 * a `{ en, sw, zh, fr }` object. Anything that is not a string is stored as
 * JSON so no translation is silently dropped.
 */
const serialiseDescription = (value) => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

/**
 * Returns the parsed translations alongside the raw description column so the
 * frontend can render a localised copy without parsing JSON itself.
 */
const withParsedDescription = (product) => {
  if (!product) return product;

  let descriptions = {};
  let description = product.description ?? null;

  if (typeof description === 'string' && description.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(description);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        descriptions = parsed;
        description = parsed.en || null;
      }
    } catch {
      // Not JSON after all — keep the raw text.
    }
  }

  return { ...product, description, descriptions };
};

/**
 * Get all products with search, category filtering, and pagination
 *
 * Query params:
 *  - `category`            exact category match (case-insensitive)
 *  - `search`              matches name / category / description
 *  - `availableOnly`       only return products flagged as available
 *  - `includeUnavailable`  keep unavailable products in the result set
 *  - `page` / `limit`      pagination
 */
export const getProducts = async (req, res, next) => {
  const {
    category,
    search,
    page = 1,
    limit = 100,
    availableOnly,
    includeUnavailable,
  } = req.query;

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = Math.min(parseInt(limit, 10) || 100, 500);
  const skip = (pageNum - 1) * limitNum;

  try {
    const whereClause = {
      ...(category && { category: { equals: category, mode: 'insensitive' } }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { category: { contains: search, mode: 'insensitive' } },
          { description: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    // The marketplace hides unavailable items unless the caller opts in.
    const hideUnavailable =
      String(availableOnly).toLowerCase() === 'true' &&
      String(includeUnavailable).toLowerCase() !== 'true';
    if (hideUnavailable) {
      whereClause.isAvailable = true;
    }

    const [products, totalCount] = await Promise.all([
      prisma.product.findMany({
        where: whereClause,
        include: { variants: true },
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.product.count({ where: whereClause }),
    ]);

    res.status(200).json({
      success: true,
      data: products.map(withParsedDescription),
      pagination: {
        totalItems: totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
        currentPage: pageNum,
        pageSize: limitNum,
      },
    });
  } catch (error) {
    next(error);
  }
};

// Get single product by ID with variants
export const getProductById = async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: { variants: true },
    });

    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.status(200).json({ success: true, data: withParsedDescription(product) });
  } catch (error) {
    next(error);
  }
};

// Create a new product (handles both variants and basic fields)
export const createProduct = async (req, res, next) => {
  const {
    name,
    category,
    description,
    image,
    basePrice,
    price,
    originalPrice,
    rating,
    stockCount,
    stock,
    wholesalePrice,
    minWholesaleQty,
    sku,
    warehouseLocation,
    isAvailable,
    variants,
  } = req.body || {};

  try {
    if (!name || !category) {
      return res.status(400).json({
        success: false,
        message: 'Product name and category are required.',
      });
    }

    const finalPrice = parseFloat(basePrice ?? price ?? 0);
    const finalStock = parseInt(stockCount ?? stock ?? 0, 10);

    const product = await prisma.product.create({
      data: {
        name: String(name).trim(),
        category: String(category).trim(),
        description: serialiseDescription(description) ?? null,
        image: image || null,
        basePrice: finalPrice,
        ...(originalPrice !== undefined && originalPrice !== null && originalPrice !== ''
          ? { originalPrice: parseFloat(originalPrice) }
          : {}),
        ...(rating !== undefined && rating !== null && rating !== ''
          ? { rating: parseFloat(rating) }
          : {}),
        ...(wholesalePrice !== undefined && wholesalePrice !== null && wholesalePrice !== ''
          ? { wholesalePrice: parseFloat(wholesalePrice) }
          : {}),
        ...(minWholesaleQty !== undefined && minWholesaleQty !== null && minWholesaleQty !== ''
          ? { minWholesaleQty: parseInt(minWholesaleQty, 10) }
          : {}),
        stockCount: Number.isNaN(finalStock) ? 0 : finalStock,
        ...(sku ? { sku: String(sku).trim() } : {}),
        ...(warehouseLocation ? { warehouseLocation: String(warehouseLocation) } : {}),
        ...(isAvailable !== undefined ? { isAvailable: Boolean(isAvailable) } : {}),
        ...(variants && Array.isArray(variants) && variants.length > 0 && {
          variants: {
            create: variants,
          },
        }),
      },
      include: { variants: true },
    });

    res.status(201).json({ success: true, data: withParsedDescription(product) });

    // Log the catalog entry in the admin activity stream.
    await notifyAdmins({
      type: 'PRODUCT',
      title: 'Product Added to Catalog',
      message: `${product.name} was added to the ${product.category} catalog.`,
    }).catch((error) =>
      console.error('[Notification] Product create event failed:', error?.message)
    );
  } catch (error) {
    if (error?.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'A product with that SKU already exists.',
      });
    }
    next(error);
  }
};

// Update product stock or details
export const updateProduct = async (req, res, next) => {
  const { id } = req.params;
  const {
    name,
    category,
    description,
    image,
    stockCount,
    stock,
    basePrice,
    price,
    originalPrice,
    rating,
    wholesalePrice,
    minWholesaleQty,
    sku,
    warehouseLocation,
    isAvailable,
  } = req.body || {};

  try {
    const existing = await prisma.product.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const parsedPrice =
      basePrice !== undefined ? parseFloat(basePrice) : price !== undefined ? parseFloat(price) : undefined;
    const parsedStock =
      stockCount !== undefined
        ? parseInt(stockCount, 10)
        : stock !== undefined
          ? parseInt(stock, 10)
          : undefined;

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        ...(name && { name: String(name).trim() }),
        ...(category && { category: String(category).trim() }),
        ...(description !== undefined && { description: serialiseDescription(description) ?? null }),
        ...(image !== undefined && { image: image || null }),
        ...(parsedPrice !== undefined && !Number.isNaN(parsedPrice) && { basePrice: parsedPrice }),
        ...(originalPrice !== undefined && {
          originalPrice: originalPrice === null || originalPrice === '' ? null : parseFloat(originalPrice),
        }),
        ...(rating !== undefined && {
          rating: rating === null || rating === '' ? undefined : parseFloat(rating),
        }),
        ...(wholesalePrice !== undefined && {
          wholesalePrice:
            wholesalePrice === null || wholesalePrice === '' ? null : parseFloat(wholesalePrice),
        }),
        ...(minWholesaleQty !== undefined && {
          minWholesaleQty:
            minWholesaleQty === null || minWholesaleQty === ''
              ? undefined
              : parseInt(minWholesaleQty, 10),
        }),
        ...(parsedStock !== undefined && !Number.isNaN(parsedStock) && { stockCount: parsedStock }),
        ...(sku !== undefined && { sku: sku || null }),
        ...(warehouseLocation !== undefined && { warehouseLocation }),
        ...(isAvailable !== undefined && { isAvailable: Boolean(isAvailable) }),
      },
      include: { variants: true },
    });

    res.status(200).json({ success: true, data: withParsedDescription(updatedProduct) });

    // Log the catalog edit in the admin activity stream.
    await notifyAdmins({
      type: 'PRODUCT',
      title: 'Product Catalog Updated Successfully',
      message: `${updatedProduct.name} was updated by ${req.user?.name || 'an administrator'}.`,
    }).catch((error) =>
      console.error('[Notification] Product update event failed:', error?.message)
    );
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    if (error?.code === 'P2002') {
      return res.status(409).json({
        success: false,
        message: 'A product with that SKU already exists.',
      });
    }
    next(error);
  }
};

/**
 * PATCH /api/products/:id/availability
 * Flips the marketplace visibility of a product without touching its details.
 */
export const updateProductAvailability = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { isAvailable } = req.body || {};

    if (isAvailable === undefined) {
      return res.status(400).json({
        success: false,
        message: 'isAvailable is required.',
      });
    }

    const product = await prisma.product.update({
      where: { id },
      data: { isAvailable: Boolean(isAvailable) },
      include: { variants: true },
    });

    res.status(200).json({
      success: true,
      message: `Product marked ${product.isAvailable ? 'available' : 'unavailable'}.`,
      data: withParsedDescription(product),
    });

    // Availability is a catalog change, so it belongs in the activity stream.
    await notifyAdmins({
      type: 'PRODUCT',
      title: 'Product Availability Updated',
      message: `${product.name} was marked ${product.isAvailable ? 'available' : 'unavailable'} in the catalog.`,
    }).catch((error) =>
      console.error('[Notification] Product availability event failed:', error?.message)
    );
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    next(error);
  }
};

// Delete product
export const deleteProduct = async (req, res, next) => {
  try {
    // Capture the name before the row disappears so the activity log reads well.
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, category: true },
    });

    await prisma.product.delete({ where: { id: req.params.id } });

    res.status(200).json({ success: true, message: 'Product deleted successfully' });

    await notifyAdmins({
      type: 'PRODUCT',
      title: 'Product Removed from Catalog',
      message: `${existing?.name || 'A product'} was deleted from the ${existing?.category || 'catalog'}.`,
    }).catch((error) =>
      console.error('[Notification] Product delete event failed:', error?.message)
    );
  } catch (error) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }
    next(error);
  }
};

// Get Business Analytics & Inventory Warnings
export const getAnalytics = async (req, res, next) => {
  try {
    const completedRevenueResult = await prisma.order.aggregate({
      where: { paymentStatus: 'PAID' },
      _sum: { totalAmount: true },
      _count: { id: true },
    });

    const pendingRevenueResult = await prisma.order.aggregate({
      where: { paymentStatus: 'PENDING' },
      _sum: { totalAmount: true },
      _count: { id: true },
    });

    const LOW_STOCK_THRESHOLD = 10;
    const lowStockProducts = await prisma.product.findMany({
      where: {
        stockCount: { lt: LOW_STOCK_THRESHOLD },
      },
      select: {
        id: true,
        name: true,
        category: true,
        stockCount: true,
        basePrice: true,
      },
      orderBy: { stockCount: 'asc' },
    });

    const totalProductsCount = await prisma.product.count();

    res.status(200).json({
      success: true,
      summary: {
        totalCompletedRevenue: completedRevenueResult._sum.totalAmount || 0,
        completedOrdersCount: completedRevenueResult._count.id,
        totalPendingRevenue: pendingRevenueResult._sum.totalAmount || 0,
        pendingOrdersCount: pendingRevenueResult._count.id,
        totalCatalogProducts: totalProductsCount,
      },
      inventoryAlerts: {
        threshold: LOW_STOCK_THRESHOLD,
        lowStockCount: lowStockProducts.length,
        items: lowStockProducts,
      },
    });
  } catch (error) {
    next(error);
  }
};
