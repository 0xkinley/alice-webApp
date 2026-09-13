ALTER TABLE file_objects
  DROP CONSTRAINT file_objects_verified_media_type_check;

ALTER TABLE file_objects
  ADD CONSTRAINT file_objects_verified_media_type_check CHECK (verified_media_type IN (
    'application/json', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/webp',
    'text/csv', 'text/plain', 'text/markdown', 'text/tab-separated-values'
  ));

ALTER TABLE file_upload_intents
  DROP CONSTRAINT file_upload_intents_claimed_media_type_check;

ALTER TABLE file_upload_intents
  ADD CONSTRAINT file_upload_intents_claimed_media_type_check CHECK (claimed_media_type IN (
    'application/json', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'image/jpeg', 'image/webp',
    'text/csv', 'text/plain', 'text/markdown', 'text/tab-separated-values'
  ));

ALTER TABLE host_file_save_offers
  DROP CONSTRAINT host_file_save_offers_declared_media_type_check;

ALTER TABLE host_file_save_offers
  ADD CONSTRAINT host_file_save_offers_declared_media_type_check CHECK (
    declared_media_type IS NULL OR declared_media_type IN (
      'application/json', 'application/pdf',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/png', 'image/jpeg', 'image/webp',
      'text/csv', 'text/plain', 'text/markdown', 'text/tab-separated-values'
    )
  );
