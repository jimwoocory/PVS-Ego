-- Preserve human-vs-AI review provenance without rewriting historical decisions.
ALTER TABLE "ReviewDecisionRecord" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'USER';
ALTER TABLE "ReviewDecisionRecord" ADD COLUMN "visualReviewJson" TEXT;
