const prisma = require('../prismaClient');

// Get all products with search, category filtering, and pagination
exports.getProducts = async (req, res, next) => {
  const { category, search, page = 1, limit = 10 } = req.query;

  const pageNum = parseInt(page, 10);
  const limitNum = parseInt(limit, 10);
  const skip = (pageNum - 1) * limitNum;

  try {
    const whereClause = {
      ...(category && { category: { equals: category, mode: 'insensitive' } }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { category: { contains: search, mode: 'insensitive' } }
        ]
      })
    };

    const [products, totalCount] = await Promise.all([
      prisma.product.findMany({
        where: whereClause,
        include: { variants: true },
        skip,
        take: limitNum,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.product.count({ where: whereClause })
    ]);

    res.status(200).json({
      data: products,
      pagination: {
        totalItems: totalCount,
        totalPages: Math.ceil(totalCount / limitNum),
        currentPage: pageNum,
        pageSize: limitNum
      }
    });
  } catch (error) {
    next(error);
  }
};

// Create a new product with variants
exports.createProduct = async (req, res) => {
  const { name, category, basePrice, stockCount, variants } = req.body;
  try {
    const product = await prisma.product.create({
      data: {
        name,
        category,
        basePrice: parseFloat(basePrice),
        stockCount: parseInt(stockCount) || 0,
        variants: {
          create: variants || []
        }
      },
      include: { variants: true }
    });
    res.status(201).json(product);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Update product stock or details
exports.updateProduct = async (req, res, next) => {
  const { id } = req.params;
  const { stockCount, basePrice, name, category } = req.body;

  try {
    const updatedProduct = await prisma.product.update({
      where: { id },
      data: {
        ...(stockCount !== undefined && { stockCount: parseInt(stockCount) }),
        ...(basePrice !== undefined && { basePrice: parseFloat(basePrice) }),
        ...(name && { name }),
        ...(category && { category })
      },
      include: { variants: true }
    });

    res.status(200).json(updatedProduct);
  } catch (error) {
    next(error); // Pass to centralized error handler
  }
};// Get Business Analytics & Inventory Warnings
exports.getAnalytics = async (req, res, next) => {
  try {
    const completedRevenueResult = await prisma.order.aggregate({
      where: { paymentStatus: 'COMPLETED' },
      _sum: { totalAmount: true },
      _count: { id: true }
    });

    const pendingRevenueResult = await prisma.order.aggregate({
      where: { paymentStatus: 'PENDING' },
      _sum: { totalAmount: true },
      _count: { id: true }
    });

    const LOW_STOCK_THRESHOLD = 10;
    const lowStockProducts = await prisma.product.findMany({
      where: {
        stockCount: {
          lt: LOW_STOCK_THRESHOLD
        }
      },
      select: {
        id: true,
        name: true,
        category: true,
        stockCount: true,
        basePrice: true
      },
      orderBy: { stockCount: 'asc' }
    });

    const totalProductsCount = await prisma.product.count();

    res.status(200).json({
      summary: {
        totalCompletedRevenue: completedRevenueResult._sum.totalAmount || 0,
        completedOrdersCount: completedRevenueResult._count.id,
        totalPendingRevenue: pendingRevenueResult._sum.totalAmount || 0,
        pendingOrdersCount: pendingRevenueResult._count.id,
        totalCatalogProducts: totalProductsCount
      },
      inventoryAlerts: {
        threshold: LOW_STOCK_THRESHOLD,
        lowStockCount: lowStockProducts.length,
        items: lowStockProducts
      }
    });
  } catch (error) {
    next(error);
  }
};

// Get all products
exports.getProducts = async (req, res, next) => {
  try {
    const products = await prisma.product.findMany();
    res.json(products);
  } catch (error) {
    next(error);
  }
};

// Get single product by ID
exports.getProductById = async (req, res, next) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id }
    });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
  } catch (error) {
    next(error);
  }
};

// Create product
exports.createProduct = async (req, res, next) => {
  try {
    const product = await prisma.product.create({ data: req.body });
    res.status(201).json(product);
  } catch (error) {
    next(error);
  }
};

// Update product
exports.updateProduct = async (req, res, next) => {
  try {
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: req.body
    });
    res.json(product);
  } catch (error) {
    next(error);
  }
};

// Delete product
exports.deleteProduct = async (req, res, next) => {
  try {
    await prisma.product.delete({ where: { id: req.params.id } });
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    next(error);
  }
};