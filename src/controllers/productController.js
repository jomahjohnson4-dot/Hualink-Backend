import prisma from '../prismaClient.js';

// Get all products with search, category filtering, and pagination
export const getProducts = async (req, res, next) => {
  const { category, search, page = 1, limit = 10 } = req.query;

  const pageNum = parseInt(page, 10) || 1;
  const limitNum = parseInt(limit, 10) || 10;
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
      data: products,
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

    res.status(200).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

// Create a new product (handles both variants and basic fields)
export const createProduct = async (req, res, next) => {
  const { name, category, description, image, basePrice, price, stockCount, stock, variants } = req.body;

  try {
    const finalPrice = parseFloat(basePrice ?? price ?? 0);
    const finalStock = parseInt(stockCount ?? stock ?? 0, 10);

    const product = await prisma.product.create({
      data: {
        name,
        category,
        description,
        image,
        basePrice: finalPrice,
        price: finalPrice,
        stockCount: finalStock,
        stock: finalStock,
        ...(variants && Array.isArray(variants) && variants.length > 0 && {
          variants: {
            create: variants,
          },
        }),
      },
      include: { variants: true },
    });

    res.status(201).json({ success: true, data: product });
  } catch (error) {
    next(error);
  }
};

// Update product stock or details
export const updateProduct = async (req, res, next) => {
  const { id } = req.params;
  const { name, category, description, image, stockCount, stock, basePrice, price } = req.body;

  try {
    const parsedPrice = basePrice !== undefined ? parseFloat(basePrice) : price !== undefined ? parseFloat(price) : undefined;
    const parsedStock = stockCount !== undefined ? parseInt(stockCount, 10) : stock !== undefined ? parseInt(stock, 10) : undefined;

    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(category && { category }),
        ...(description && { description }),
        ...(image && { image }),
        ...(parsedPrice !== undefined && { basePrice: parsedPrice, price: parsedPrice }),
        ...(parsedStock !== undefined && { stockCount: parsedStock, stock: parsedStock }),
      },
      include: { variants: true },
    });

    res.status(200).json({ success: true, data: updatedProduct });
  } catch (error) {
    next(error);
  }
};

// Delete product
export const deleteProduct = async (req, res, next) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.status(200).json({ success: true, message: 'Product deleted successfully' });
  } catch (error) {
    next(error);
  }
};

// Get Business Analytics & Inventory Warnings
export const getAnalytics = async (req, res, next) => {
  try {
    const completedRevenueResult = await prisma.order.aggregate({
      where: { paymentStatus: 'COMPLETED' },
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
        OR: [
          { stockCount: { lt: LOW_STOCK_THRESHOLD } },
          { stock: { lt: LOW_STOCK_THRESHOLD } },
        ],
      },
      select: {
        id: true,
        name: true,
        category: true,
        stockCount: true,
        stock: true,
        basePrice: true,
        price: true,
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