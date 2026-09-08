-- Call-based vendor sync: no daily download cap, queued catalogue rebuild flag.
INSERT INTO sil_settings (setting_key, setting_value)
VALUES ('pending_catalogue_rebuild', '0')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
