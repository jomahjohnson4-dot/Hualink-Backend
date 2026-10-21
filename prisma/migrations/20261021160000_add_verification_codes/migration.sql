-- ==========================================
-- ACCOUNT VERIFICATION + VERIFICATION CODES
-- ==========================================

-- Extend the notification taxonomy so the alert centre can separate account
-- activity (sign-ups, OTP confirmations) from commerce activity.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SIGNUP';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'VERIFY';

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('SIGNUP', 'ORDER');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'FAILED');

-- AlterTable — account verification flag
ALTER TABLE "users" ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "verified_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "verification_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL DEFAULT 'SIGNUP',
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "email" TEXT,
    "phone" TEXT,
    "user_id" TEXT,
    "order_id" TEXT,
    "amount" DOUBLE PRECISION,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verification_codes_email_purpose_idx" ON "verification_codes"("email", "purpose");

-- CreateIndex
CREATE INDEX "verification_codes_user_id_purpose_idx" ON "verification_codes"("user_id", "purpose");

-- CreateIndex
CREATE INDEX "verification_codes_status_idx" ON "verification_codes"("status");

-- AddForeignKey
ALTER TABLE "verification_codes" ADD CONSTRAINT "verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
