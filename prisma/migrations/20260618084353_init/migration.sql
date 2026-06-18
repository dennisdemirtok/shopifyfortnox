-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'fortnox',
    "tenant" TEXT NOT NULL DEFAULT 'default',
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "scope" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "refreshExpiresAt" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerMapping" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyLocationId" TEXT NOT NULL,
    "organisationNumber" TEXT,
    "fortnoxCustomerNumber" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderMapping" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "orderName" TEXT,
    "fulfillmentId" TEXT NOT NULL DEFAULT '',
    "fortnoxOrderNumber" TEXT,
    "fortnoxInvoiceNumber" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT,
    "flow" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "step" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedWebhook" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopDomain" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorefrontConfig" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "market" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'SEK',
    "b2bModel" TEXT NOT NULL DEFAULT 'native',
    "pricesIncludeVat" BOOLEAN NOT NULL DEFAULT false,
    "vatRegime" TEXT NOT NULL DEFAULT 'inhemsk',
    "shippingArticleNr" TEXT,
    "sendMethod" TEXT NOT NULL DEFAULT 'email',
    "taggedB2bTag" TEXT,
    "paymentTermsMap" JSONB,
    "accountMap" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorefrontConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleMapping" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "articleNumber" TEXT NOT NULL,
    "description" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ArticleMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthToken_provider_tenant_key" ON "OAuthToken"("provider", "tenant");

-- CreateIndex
CREATE INDEX "CustomerMapping_organisationNumber_idx" ON "CustomerMapping"("organisationNumber");

-- CreateIndex
CREATE INDEX "CustomerMapping_fortnoxCustomerNumber_idx" ON "CustomerMapping"("fortnoxCustomerNumber");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerMapping_shopDomain_companyLocationId_key" ON "CustomerMapping"("shopDomain", "companyLocationId");

-- CreateIndex
CREATE INDEX "OrderMapping_state_idx" ON "OrderMapping"("state");

-- CreateIndex
CREATE UNIQUE INDEX "OrderMapping_shopDomain_shopifyOrderId_fulfillmentId_key" ON "OrderMapping"("shopDomain", "shopifyOrderId", "fulfillmentId");

-- CreateIndex
CREATE INDEX "AuditLog_shopDomain_flow_idx" ON "AuditLog"("shopDomain", "flow");

-- CreateIndex
CREATE INDEX "AuditLog_entityId_idx" ON "AuditLog"("entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWebhook_webhookId_key" ON "ProcessedWebhook"("webhookId");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontConfig_shopDomain_key" ON "StorefrontConfig"("shopDomain");

-- CreateIndex
CREATE UNIQUE INDEX "ArticleMapping_sku_key" ON "ArticleMapping"("sku");
