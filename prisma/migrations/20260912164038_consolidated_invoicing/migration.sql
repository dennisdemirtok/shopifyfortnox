-- AlterTable
ALTER TABLE "CustomerMapping" ADD COLUMN     "invoiceMode" TEXT NOT NULL DEFAULT 'per_order',
ADD COLUMN     "lastConsolidatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderMapping" ADD COLUMN     "companyLocationId" TEXT,
ADD COLUMN     "currency" TEXT,
ADD COLUMN     "fortnoxCustomerNumber" TEXT;

-- CreateIndex
CREATE INDEX "OrderMapping_shopDomain_state_companyLocationId_idx" ON "OrderMapping"("shopDomain", "state", "companyLocationId");
