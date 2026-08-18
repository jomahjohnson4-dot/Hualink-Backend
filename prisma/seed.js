const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('Seeding database...');

  // Create Default Admin
  const hashedPassword = await bcrypt.hash('Admin@12345', 10);
  const admin = await prisma.admin.upsert({
    where: { email: 'admin@hualink.co.tz' },
    update: {},
    create: {
      email: 'admin@hualink.co.tz',
      password: hashedPassword
    }
  });

  // Create Seed Products
  const products = [
    {
      name: 'Fast Charger 65W GaN',
      category: 'Chargers & Cables',
      basePrice: 45000,
      stockCount: 80
    },
    {
      name: 'Wireless Powerbank 10000mAh',
      category: 'Power Banks',
      basePrice: 35000,
      stockCount: 50
    },
    {
      name: 'USB-C to Lightning Cable 2m',
      category: 'Chargers & Cables',
      basePrice: 15000,
      stockCount: 200
    }
  ];

  for (const item of products) {
    await prisma.product.create({ data: item });
  }

  console.log('Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });