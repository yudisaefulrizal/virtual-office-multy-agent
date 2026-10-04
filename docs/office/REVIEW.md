# Desain dan audit kantor 3D

Referensi dibuat dengan model gambar melalui tool bawaan `image_gen`. Prompt lengkap: [imagegen-prompt.txt](imagegen-prompt.txt). [Konsep visual](office-concept.png) dan [hasil implementasi di browser](office-implemented.png) disimpan bersama audit ini.

## Desain yang diterapkan

Kantor tetap berupa geometri interaktif Three.js. Referensi gambar diterjemahkan menjadi fondasi berlapis dengan tepi lembut, lantai netral, meja kayu hangat, kursi dan sofa teal, partisi kaca dengan rangka gelap, serta ambang pintu kayu. Warna divisi menjadi aksen lembut sehingga avatar dan koridor lebih jelas. Kontrol **Nama staf** menyembunyikan label saat melihat arsitektur; **Reset tampilan** mengembalikan kamera setelah orbit/pan/zoom. Zoom otomatis sekarang dapat mengecil untuk lantai besar dan layar kecil. Hitungan staf mengikuti lantai yang sedang dilihat.

## Cacat logika dan perbaikannya

| Pemicu | Perilaku sebelumnya | Perbaikan |
| --- | --- | --- |
| Dinding tipis berada di antara pusat grid, atau badan/kaki lebih lebar daripada garis jalur | Dinding hanya tercermin secara tidak langsung dari interior grid; garis yang dianggap terbuka masih dapat melewati dinding renderer | Semua dinding interior dan luar memakai geometri bersama dengan renderer. Collider diperbesar 0,46 satuan untuk badan serta ayunan kaki/tangan; pemeriksaan ruas kontinu dipakai di A*, penghalusan jalur, akses sofa, dan setiap langkah gerak |
| A* tidak menemukan jalur | `begin(walk)` langsung mengubah posisi ke tujuan; langkah `sit` juga dapat memindahkan avatar tanpa berjalan | Jalur gagal dibatalkan, posisi dipertahankan, dan langkah duduk memeriksa jarak ke kursi. Perjalanan pulang yang gagal dicoba lagi dengan jeda |
| Tujuan berada di perabot/luar lantai | `findPath` mencari sel terbuka terdekat lalu tetap menambahkan tujuan asli, sehingga ruas terakhir dapat menembus objek | Tujuan tertutup ditolak. Sofa mendapat ruas akses khusus dari sisi depan, termasuk untuk keluar saat aktivitas terputus di tengah ruas itu |
| Titik awal/akhir berada dekat tepi sel grid | Pusat sel pertama dan terakhir dibuang; ruas pendek yang tersisa tidak selalu diperiksa | Kedua pusat sel tetap ada; setiap ruas biasa diverifikasi sebelum jalur dikembalikan |
| Peserta rapat lebih dari delapan | Indeks kursi memakai modulo, sehingga beberapa avatar duduk pada koordinat yang sama | Delapan kursi unik, lalu titik berdiri unik. Jika kapasitas fisik habis atau lantai tidak memiliki ruang rapat, peserta mengikuti rapat dari meja |
| Peserta bergabung/keluar saat rapat berlangsung | Urutan dihitung hanya ketika mode berubah; peserta baru bisa mengambil kursi peserta lama | Alokasi tempat disimpan per ID dan hanya tempat peserta yang keluar dilepas. Perhitungan ulang dilakukan ketika keanggotaan berubah |
| Pekerjaan baru datang ketika staf mengantarkan hasil | Mode serah-terima yang sedang berjalan tetap menang atas pekerjaan | Status bekerja/menunggu/blocked memutus animasi serah-terima dan staf berjalan kembali ke meja |
| Beberapa staf menyelesaikan pekerjaan bersamaan | Semua mendatangi titik samping Manager yang sama; Manager dapat pergi ke pantry/rapat | Satu kunjungan pada satu waktu. Manager tetap di meja selama kunjungan; kunjungan dibatalkan jika Manager menjadi nonaktif atau masuk rapat |
| Kunjungan pertama memerlukan lebih dari sembilan detik | Jika kunjungan dibuat antre, event staf berikutnya kedaluwarsa sebelum bisa dilayani | Event baru diterima dalam sembilan detik dan disimpan dalam antrean hingga satu menit. Event ditandai selesai setelah gestur menyerahkan selesai, sehingga pembatalan sebelum itu tidak menganggap hasil sudah diserahkan |
| Obrolan dibatalkan saat kedua staf masih menuju pantry | Grup baru dipasang setelah tiba; pasangan tidak mengetahui pembatalan dan dapat menunggu 25 detik | Kedua staf terhubung ke grup sejak janji dibuat; pembatalan memberi sinyal ke pasangan sebelum tiba |
| Staf dinonaktifkan ketika berada di luar meja | `snapHome` menyebabkan teleport | Staf menjadi transparan dan berjalan pulang memakai jalur normal |
| ID avatar kurang dari enam karakter | `charCodeAt(5)` menghasilkan `NaN`; fase animasi dan rotasi anggota tubuh ikut rusak | Fase animasi berasal dari hash seluruh ID, termasuk ID kosong/pendek/Unicode |
| Frame browser tertunda | Durasi aksi mengikuti waktu clock penuh, sementara jarak berjalan dibatasi `dt` 0,1 detik | Perjalanan dan durasi aksi memakai waktu simulasi yang sama, terakumulasi dari delta yang dibatasi |

Audit visual juga memperbaiki monitor yang membelakangi staf serta permukaan jendela dan bingkai yang coplanar sehingga berkedip/bersegitiga gelap akibat z-fighting.

## Validasi

- `npm run typecheck` lulus.
- `npm test -- --run test/office-behavior.test.ts test/office-layout.test.ts`: 30 tes lulus, termasuk jarak gerak untuk semua pose, 11 peserta rapat, penambahan peserta, jalur putus, akses sofa, pembatalan obrolan, status nonaktif, serta antrean serah-terima dengan jam nyata yang disimulasikan. Pemeriksaan independen menyampel badan berjari-jari 0,46 terhadap geometri dinding di sepanjang jalur dan selama 900 detik simulasi idle. Ada regresi khusus untuk dinding lebih tipis daripada grid, pembukaan sel yang tidak boleh menghapus collider, serta dinding baru yang memotong path yang sedang dijalankan.
- Pemeriksaan tambahan menggunakan roster kantor yang sedang berjalan (9 staf, 1 lantai): 529 pasangan jalur tanpa tujuan terputus, lalu 900 detik simulasi lokal dengan rapat, pekerjaan, serah-terima, dan perubahan nonaktif. Dari 598.812 sampel posisi/ruas terhadap dinding fisik, tidak ditemukan benturan. Simulasi ini tidak mengubah status staf atau menjalankan task di server.
- `npm run web:build` lulus.
- Pemeriksaan browser menggunakan Chrome headless dan Playwright: rendering kantor, kontrol label/kamera, layar desktop/mobile, dan susunan staf beberapa lantai. Hasil dan error dicatat selama pemeriksaan; screenshot implementasi menggunakan kantor yang sedang berjalan.

Tes kantor memakai konfigurasi Vitest proyek, termasuk migrasi database pengujian. Suite backend penuh tidak dijalankan karena perubahan terfokus pada frontend dan simulasi kantor.

## Batas yang masih ada

1. Avatar belum melakukan penghindaran tabrakan terhadap avatar lain saat berjalan. Reservasi tempat mencegah perebutan tujuan tertentu, tetapi dua staf masih bisa berpapasan saling menembus di koridor. Penyelesaian berikutnya memerlukan penghindaran lokal atau reservasi ruas jalan; sekadar menghentikan keduanya dapat membuat deadlock.
2. Belum ada tangga/lift maupun perpindahan fisik antarlantai. Staf di lantai tanpa ruang rapat mengikuti rapat dari meja, dan pengantaran fisik ke Manager di lantai lain tidak divisualisasikan. Mengganti lantai/remodel organisasi membuat mesin lokal baru, sehingga avatar mulai lagi di meja.
3. Perabot/kursi masih memakai pendekatan grid 0,5 satuan. Untuk dinding, ruas gerak diperiksa secara kontinu terhadap collider yang diperbesar sesuai jangkauan avatar; lorong lebih sempit daripada badan ditolak. Bentuk collider konservatif dapat menolak sebagian celah yang secara visual tampak cukup lebar.
4. Event serah-terima bersifat visual dan dibatasi umur satu menit. Event yang baru terlihat setelah jendela penerimaan, atau antrean yang melewati satu menit, tidak menghasilkan kunjungan. Hasil kerja sebenarnya tetap tersedia di backend.
