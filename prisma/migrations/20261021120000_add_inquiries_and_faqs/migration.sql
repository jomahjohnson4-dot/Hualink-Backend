-- CreateEnum
CREATE TYPE "InquiryStatus" AS ENUM ('NEW', 'REPLIED', 'RESOLVED');

-- AlterTable
ALTER TABLE "products" ADD COLUMN "is_available" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN "original_price" DOUBLE PRECISION;
ALTER TABLE "products" ADD COLUMN "rating" DOUBLE PRECISION NOT NULL DEFAULT 4.8;

-- CreateTable
CREATE TABLE "inquiries" (
    "id" TEXT NOT NULL,
    "customer_name" TEXT NOT NULL,
    "customer_contact" TEXT NOT NULL,
    "product_or_service" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "InquiryStatus" NOT NULL DEFAULT 'NEW',
    "replied_at" TIMESTAMP(3),
    "admin_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "faqs" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "faqs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inquiries_status_idx" ON "inquiries"("status");

-- CreateIndex
CREATE INDEX "inquiries_created_at_idx" ON "inquiries"("created_at");
