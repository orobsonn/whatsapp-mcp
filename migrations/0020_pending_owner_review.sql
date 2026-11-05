-- Only native human reviews may wait for the owner's decision without a deadline.
ALTER TABLE approved_sends ADD COLUMN owner_pending_review INTEGER NOT NULL DEFAULT 0 CHECK(owner_pending_review IN(0,1));
