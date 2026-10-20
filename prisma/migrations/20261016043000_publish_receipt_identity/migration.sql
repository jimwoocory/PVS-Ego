-- Keep structured platform identifiers separate from legacy receipt references.
-- Original receipt IDs and all historical receipts remain unchanged.
CREATE TABLE "PublishReceiptIdentityRecord" (
    "receiptId" TEXT NOT NULL PRIMARY KEY,
    "identityJson" TEXT NOT NULL,
    CONSTRAINT "PublishReceiptIdentityRecord_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "PublishReceiptRecord" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
