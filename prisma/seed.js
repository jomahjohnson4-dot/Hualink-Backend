import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Starting database seed...');

  // 1. Create Default Admin User
  const hashedPassword = await bcrypt.hash('Admin@12345', 10);
  const admin = await prisma.admin.upsert({
    where: { email: 'admin@hualink.co.tz' },
    update: {},
    create: {
      email: 'admin@hualink.co.tz',
      password: hashedPassword,
    },
  });
  console.log(`✅ Admin account created/verified: ${admin.email}`);

  // 2. Clear previous records in correct dependency order
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();

  // Create products
  const chargerProduct = await prisma.product.create({
    data: {
      name: 'Fast Charger 65W GaN',
      category: 'Chargers & Cables',
      basePrice: 45000,
      stockCount: 80,
    },
  });

  await prisma.product.createMany({
    data: [
      {
        name: 'Wireless Powerbank 10000mAh',
        category: 'Power Banks',
        basePrice: 35000,
        stockCount: 50,
      },
      {
        name: 'USB-C to Lightning Cable 2m',
        category: 'Chargers & Cables',
        basePrice: 15000,
        stockCount: 200,
      },
    ],
  });
  console.log('✅ E-commerce products seeded successfully!');

  // 3. Create Sample Order with required `orderNumber`
  const testOrder = await prisma.order.create({
    data: {
      orderNumber: `HL-${Date.now().toString().slice(-6)}`,
      customerPhone: '0700000000',
      paymentMethod: 'M-PESA',
      paymentStatus: 'PENDING',
      totalAmount: 45000,
      items: {
        create: [
          {
            productId: chargerProduct.id,
            quantity: 1,
            unitPrice: 45000,
          },
        ],
      },
    },
    include: { items: true },
  });

  console.log(`✅ Sample order created! ID: ${testOrder.id} (Order No: ${testOrder.orderNumber})`);

  // 4. Seed Services Hub
  await prisma.service.deleteMany();
  await prisma.service.createMany({
    data: [
      {
        title: 'Custom Web & Mobile App Development',
        category: 'web',
        provider: 'Hualink Tech Solutions',
        phone: '255700000000',
        price: 'From 700,000 TSH',
        timeline: '5-10 Days Delivery',
        location: 'Dar es Salaam & Online',
        description:
          'Professional responsive web applications, e-commerce storefronts, and custom client-side software engineered with modern UI/UX standards.',
        tag: 'Top Rated',
        status: 'Online Now',
        image:
          'https://images.unsplash.com/photo-1555066931-4365d14bab8c?auto=format&fit=crop&w=600&q=80',
      },
      {
        title: 'Logo, Posters, Flyers & Brand Banners',
        category: 'graphic',
        provider: 'TeKeL Graphics Studio',
        phone: '255700000000',
        price: 'From 25,000 TSH',
        timeline: '24 Hours Turnaround',
        location: 'Mbeya & Regional Hubs',
        description:
          'High-impact visual identity design, custom company logos, marketing posters, social media banners, and promotional print assets.',
        tag: 'TeKeL Branding',
        status: 'Fast Response',
        image:
          'https://images.unsplash.com/photo-1626785774573-4b799315345d?auto=format&fit=crop&w=600&q=80',
      },
      {
        title: 'Modern Office & Home Furniture Supply',
        category: 'furniture',
        provider: 'Hualink Logistics & Interiors',
        phone: '255700000000',
        price: 'From 150,000 TSH',
        timeline: 'Instant Stock / 3 Days Custom',
        location: 'Dar es Salaam Depot',
        description:
          'Durable executive desks, ergonomic office chairs, custom shelving units, and contemporary home furnishing solutions built for longevity.',
        tag: 'Direct Supply',
        status: 'Available',
        image:
          'https://images.unsplash.com/photo-1538688525198-9b88f6f53126?auto=format&fit=crop&w=600&q=80',
      },
      {
        title: 'Computer Maintenance, Repair & Networking',
        category: 'tech',
        provider: 'Hualink Systems Support',
        phone: '255700000000',
        price: 'From 30,000 TSH',
        timeline: 'Same Day Service',
        location: 'All Regional Depots',
        description:
          'Professional laptop/desktop hardware diagnosis, operating system troubleshooting, driver installation, and office network routing setups.',
        tag: 'Verified Tech',
        status: 'Online Now',
        image:
          'https://images.unsplash.com/photo-1588508065123-287b28e013da?auto=format&fit=crop&w=600&q=80',
      },
    ],
  });
  console.log('✅ Services Hub seeded successfully!');

  console.log('🎉 Seeding completed successfully!');
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });