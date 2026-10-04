-- Each model-week cell records where and from which OS it was uploaded, not where it was used.
-- Older uploads have unknown context; replacement changes only the weeks it replaces.
ALTER TABLE weekly_counts ADD COLUMN upload_country TEXT CHECK (
    upload_country IS NULL OR (length(upload_country) = 2 AND upload_country GLOB '[A-Z][A-Z]')
);
ALTER TABLE weekly_counts ADD COLUMN upload_os TEXT CHECK (
    upload_os IS NULL OR upload_os IN ('linux', 'macos', 'windows', 'other')
);
