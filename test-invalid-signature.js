import dotenv from 'dotenv';
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

dotenv.config();

async function runInvalidSignatureTest() {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const latestOrder = await prisma.order.findFirst({
    orderBy: { createdAt: 'desc' },
  });

  if (!latestOrder) {
    console.log('❌ No order found in database!');
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  }

  const body = JSON.stringify({
    orderId: latestOrder.id,
    status: 'COMPLETED',
    transactionRef: 'TXN_TAMPERED_999999',
  });

  // Intentional invalid / tampered signature
  const fakeSignature = 'invalid_sha256_signature_hash_1234567890abcdef';

  const curlCmd = `curl -s -i -X POST http://localhost:5000/api/orders/payment-webhook \\
    -H "Content-Type: application/json" \\
    -H "x-signature: ${fakeSignature}" \\
    -d '${body}'`;

  console.log('🧪 Sending request with TAMPERED signature...');
  const response = execSync(curlCmd).toString();
  console.log(response);

  await prisma.$disconnect();
  await pool.end();
}

runInvalidSignatureTest().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
