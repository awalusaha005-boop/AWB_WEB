# By RB Tool — ML Model Reference

Tool AWB By RB V2 (PyInstaller Windows app). Digunakan sebagai referensi logic Opsi 2 (search by date/time/city).

## Cara Kerja Opsi 2 (Pencarian Spesifik)

Algoritma 2-phase:

### Phase 1: MID Prediction (Ridge Regression)
Memprediksi MID (4 digit pertama setelah prefix 0046) berdasarkan tanggal + jam.
- **5 fitur**: day_offset, hour, day_of_week, is_weekend, (1 fitur tambahan)
- **Standardization**: (x - x_mean) / x_std
- **Prediksi**: sum(weights_i * z_i) + y_mean
- **R²**: 0.9667 (122K samples) — sangat akurat

### Phase 2: AREA Scanning (KDE)
Setelah MID ditemukan, scan AREA (4 digit terakhir) dengan:
- **KDE per-kota**: distribusi probabilitas AREA untuk tiap kota tujuan
- **Dest Cache**: 392 entry cache tujuan → AREA (hit_count >= 2 langsung pakai)
- **Spiral order**: scan dari MID yang diprediksi, meluas ke luar

### MID Variance Model
- **daily_ranges**: tracking variance MID per hari
- **Adaptive radius**: semakin besar variance → radius scan semakin lebar
- **_max_daily_range**: 75

## Struktur Model (awb_ml_model.pkl)

Class: `awb.AWBMLEngine` (version 5, trained=True, 122,535 samples)

### RidgeModel
```
n_feat: 5
alpha: 0.5 (regularization)
weights: [53.59, 4.85, 151.70, 5.81, 41.67]
bias: 0.0
x_mean: [131.00, 11.14, 0.69, 0.58, 0.03]
x_std:  [1.83, 1.60, 0.35, 0.24, 0.18]
y_mean: 1134.90
```

### Base Model (pre-training) — ini yang dipakai web version
```
_base_slope: 42.81
_base_intercept: -5148.56
```
Web version `ml-engine.js` pakai ini: `weights: [42.81, 0, 0, 0]`, `bias: -5148.56`

### City KDE
- 1 kota: "jakarta utara" dengan data distribusi AREA
- bandwidth: 6.0

### Dest Cache
- 392 entries: city_key → {area, hit_count}

## Perbandingan Web vs By RB

| Fitur | Web (ml-engine.js) | By RB (trained) |
|-------|--------------------| ---------------|
| Features | 4 | 5 |
| Standardization | No | Yes (x_mean, x_std, y_mean) |
| Weights | [42.81, 0, 0, 0] (stub) | [53.59, 4.85, 151.70, 5.81, 41.67] |
| Bias | -5148.56 | 0.0 (dengan y_mean=1134.90) |
| R² | N/A | 0.9667 |
| City KDE | Empty | 1 kota + data |
| Dest Cache | Empty | 392 entries |
| Samples | 0 | 122,535 |

## Upgrade Path
1. **Port RidgeModel ke 5 fitur + standardization** — ganti dari stub ke trained weights
2. **Seed City KDE dari By RB model** — inject data distribusi AREA
3. **Seed Dest Cache** — inject 392 entry cache
4. **Implement MID Variance** — daily_ranges tracking

## Files
- `awb_ml_model.pkl.xz` — Trained ML model (decompress: `xz -d awb_ml_model.pkl.xz`)
- `awb.enc` / `awb.enc.xz` — Encrypted data/config (Fernet)
- `config.enc` / `config.enc.xz` — Encrypted config (Fernet)