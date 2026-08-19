-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "price" TEXT NOT NULL,
    "timeline" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "tag" TEXT DEFAULT 'Verified Service',
    "status" TEXT NOT NULL DEFAULT 'Online Now',
    "image" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);
