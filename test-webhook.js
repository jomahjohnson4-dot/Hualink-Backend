import dotenv from 'dotenv';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

dotenv.config();

async function runTest() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  // 1. Fetch latest order directly from database
  const latestOrder = await prisma.order.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  if (!latestOrder) {
    console.log('❌ No order found in database! Run "node prisma/seed.js" first.');
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  }

  console.log('✅ Found seeded order in DB. ID:', latestOrder.id);

  // 2. Build signed payload
  const secret = process.env.PAYMENT_WEBHOOK_SECRET || 'my_super_secret_key_123';
  const body = JSON.stringify({
    orderId: latestOrder.id,
    status: 'COMPLETED',
    transactionRef: 'TXN_AZAM_998877',
  });

  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');

  // 3. Execute webhook endpoint test
  const curlCmd = `curl -s -X POST http://localhost:5000/api/orders/payment-webhook \\
    -H "Content-Type: application/json" \\
    -H "x-signature: ${signature}" \\
    -d '${body}'`;

  console.log('🚀 Executing signed payment webhook...');
  const response = execSync(curlCmd).toString();
  console.log('📩 Endpoint Response:', response);

  // 4. Verify status updated in database
  const updatedOrder = await prisma.order.findUnique({
    where: { id: latestOrder.id },
  });

  console.log(`📊 Order Payment Status in DB: ${updatedOrder?.paymentStatus}`);

  await prisma.$disconnect();
  await pool.end();
}

runTest().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
