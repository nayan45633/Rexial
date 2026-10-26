-- Whether a quiz session runs with live host video (apps/streaming).
-- Existing sessions were all plain quizzes.
ALTER TABLE "QuizSession" ADD COLUMN "liveVideo" BOOLEAN NOT NULL DEFAULT false;
