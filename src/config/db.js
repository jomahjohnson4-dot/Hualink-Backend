import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

prisma.$connect()
  .then(() => {
    console.log("info: ✅ PostgreSQL Database connected cleanly with Driver Adapter");
  })
  .catch((err) => {
    console.error("error: ❌ Database connection failed:", err);
  });

export default prisma;
