-- Agent yang dinonaktifkan karena provider runtime-nya belum ada kini punya status sendiri,
-- agar bisa diaktifkan otomatis saat Owner memasang provider (DESIGN.md §4.5).
UPDATE `agents` SET `status` = 'waiting_provider' WHERE `runtime` = 'openrouter' AND `status` = 'inactive';
