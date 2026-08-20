import {
  updateStockService,
  getLowStockProductsService,
} from '../services/inventoryService.js';

export const updateProductStock = async (req, res) => {
  try {
    const { productId } = req.params;
    const { stockCount, warehouseLocation } = req.body;

    const updated = await updateStockService({
      productId,
      stockCount,
      warehouseLocation,
    });

    return res.status(200).json({
      success: true,
      message: 'Product stock updated successfully.',
      data: updated,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const getLowStockAlerts = async (req, res) => {
  try {
    const threshold = req.query.threshold || 10;
    const items = await getLowStockProductsService(threshold);

    return res.status(200).json({
      success: true,
      count: items.length,
      data: items,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};