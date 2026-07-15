-- CreateTable
CREATE TABLE "BlockHeader" (
    "height" INTEGER NOT NULL,
    "blockHash" TEXT NOT NULL,
    "parentHash" TEXT NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockHeader_pkey" PRIMARY KEY ("height")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" SERIAL NOT NULL,
    "address" TEXT NOT NULL,
    "parent" TEXT,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discoveredAtBlock" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "proposalCounter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractConfig" (
    "id" SERIAL NOT NULL,
    "contractId" INTEGER NOT NULL,
    "validFromBlock" INTEGER NOT NULL,
    "eventOrder" INTEGER NOT NULL DEFAULT 0,
    "threshold" INTEGER,
    "numOwners" INTEGER,
    "nonce" INTEGER,
    "parentNonce" INTEGER,
    "configNonce" INTEGER,
    "delegate" TEXT,
    "childMultiSigEnabled" BOOLEAN,
    "ownersCommitment" TEXT,
    "networkId" TEXT,
    "sourceEventId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerMembership" (
    "id" SERIAL NOT NULL,
    "contractId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "index" INTEGER,
    "ownerHash" TEXT,
    "validFromBlock" INTEGER NOT NULL,
    "eventOrder" INTEGER NOT NULL DEFAULT 0,
    "sourceEventId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" SERIAL NOT NULL,
    "contractId" INTEGER NOT NULL,
    "proposalHash" TEXT NOT NULL,
    "proposer" TEXT,
    "toAddress" TEXT,
    "tokenId" TEXT,
    "txType" TEXT,
    "data" TEXT,
    "nonce" TEXT,
    "configNonce" TEXT,
    "expirySlot" TEXT,
    "networkId" TEXT,
    "guardAddress" TEXT,
    "memo" TEXT,
    "memoHash" TEXT,
    "executionMemoHash" TEXT,
    "destination" TEXT,
    "childAccount" TEXT,
    "lastApproveTxHash" TEXT,
    "lastApproveError" TEXT,
    "lastExecuteTxHash" TEXT,
    "lastExecuteError" TEXT,
    "createdAtBlock" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalReceiver" (
    "id" SERIAL NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "idx" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalReceiver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" SERIAL NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "approver" TEXT NOT NULL,
    "approvalRaw" TEXT,
    "blockHeight" INTEGER NOT NULL,
    "eventOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalExecution" (
    "id" SERIAL NOT NULL,
    "proposalId" INTEGER NOT NULL,
    "blockHeight" INTEGER NOT NULL,
    "txHash" TEXT,
    "eventOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProposalExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRaw" (
    "id" SERIAL NOT NULL,
    "contractId" INTEGER,
    "blockHeight" INTEGER NOT NULL,
    "txHash" TEXT,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventRaw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexerCursor" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IndexerCursor_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "BlockHeader_blockHash_idx" ON "BlockHeader"("blockHash");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_address_key" ON "Contract"("address");

-- CreateIndex
CREATE INDEX "Contract_parent_idx" ON "Contract"("parent");

-- CreateIndex
CREATE INDEX "Contract_discoveredAtBlock_idx" ON "Contract"("discoveredAtBlock");

-- CreateIndex
CREATE INDEX "ContractConfig_contractId_validFromBlock_eventOrder_idx" ON "ContractConfig"("contractId", "validFromBlock" DESC, "eventOrder" DESC);

-- CreateIndex
CREATE INDEX "ContractConfig_validFromBlock_idx" ON "ContractConfig"("validFromBlock");

-- CreateIndex
CREATE INDEX "OwnerMembership_contractId_address_validFromBlock_eventOrde_idx" ON "OwnerMembership"("contractId", "address", "validFromBlock" DESC, "eventOrder" DESC);

-- CreateIndex
CREATE INDEX "OwnerMembership_contractId_validFromBlock_idx" ON "OwnerMembership"("contractId", "validFromBlock" DESC);

-- CreateIndex
CREATE INDEX "OwnerMembership_validFromBlock_idx" ON "OwnerMembership"("validFromBlock");

-- CreateIndex
CREATE INDEX "Proposal_contractId_createdAtBlock_idx" ON "Proposal"("contractId", "createdAtBlock");

-- CreateIndex
CREATE INDEX "Proposal_createdAtBlock_idx" ON "Proposal"("createdAtBlock");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_contractId_proposalHash_key" ON "Proposal"("contractId", "proposalHash");

-- CreateIndex
CREATE INDEX "ProposalReceiver_proposalId_idx" ON "ProposalReceiver"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalReceiver_proposalId_idx_key" ON "ProposalReceiver"("proposalId", "idx");

-- CreateIndex
CREATE INDEX "Approval_proposalId_blockHeight_idx" ON "Approval"("proposalId", "blockHeight");

-- CreateIndex
CREATE INDEX "Approval_blockHeight_idx" ON "Approval"("blockHeight");

-- CreateIndex
CREATE UNIQUE INDEX "Approval_proposalId_approver_key" ON "Approval"("proposalId", "approver");

-- CreateIndex
CREATE INDEX "ProposalExecution_proposalId_blockHeight_idx" ON "ProposalExecution"("proposalId", "blockHeight");

-- CreateIndex
CREATE INDEX "ProposalExecution_blockHeight_idx" ON "ProposalExecution"("blockHeight");

-- CreateIndex
CREATE UNIQUE INDEX "ProposalExecution_proposalId_key" ON "ProposalExecution"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "EventRaw_fingerprint_key" ON "EventRaw"("fingerprint");

-- CreateIndex
CREATE INDEX "EventRaw_contractId_blockHeight_idx" ON "EventRaw"("contractId", "blockHeight");

-- CreateIndex
CREATE INDEX "EventRaw_blockHeight_idx" ON "EventRaw"("blockHeight");

-- AddForeignKey
ALTER TABLE "ContractConfig" ADD CONSTRAINT "ContractConfig_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnerMembership" ADD CONSTRAINT "OwnerMembership_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalReceiver" ADD CONSTRAINT "ProposalReceiver_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalExecution" ADD CONSTRAINT "ProposalExecution_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRaw" ADD CONSTRAINT "EventRaw_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;
