-- The AI Assistant must allow attaching the same uploaded file to multiple
-- messages: the same CV in a second conversation, or re-sending after a
-- failed generation. The original UNIQUE constraint on
-- ai_message_files.storage_path made every second association fail, and
-- prepareChat() silently ignored the insert error — so the AI never saw the
-- file and the user saw no error ("attachment sent but not analyzed").
--
-- ai_file_uploads remains the single source of truth for the stored object
-- (its storage_path stays unique), so the per-message association table can
-- safely be non-unique.
alter table public.ai_message_files
  drop constraint if exists ai_message_files_storage_path_key;
