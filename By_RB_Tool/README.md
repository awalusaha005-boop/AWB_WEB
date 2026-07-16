# By RB Tool — ML Model Reference

Tool AWB By RB V2 (PyInstaller Windows app). Digunakan sebagai referensi logic Opsi 2 (search by date/time/city).

## Struktur Model (awb_ml_model.pkl)

Class: `awb.AWBMLEngine`

### RidgeModel (MID prediction)
- `n_feat`: 5 (vs web version: 4)
- `alpha`: 0.5 (regularization)
- `weights`: [53.59, 4.85, 151.70, 5.81, 41.67]
- `bias`: 0.0
- Standardization: `x_mean`, `x_std`, `y_mean`

### City KDE (per-kota AREA distribution)
- Dictionary of city → KDE model
- Bandwidth: Silverman's rule

### Web Version Comparison
| Feature | By RB | Web (ml-engine.js) |
|---------|-------|---------------------|
| Features | 5 | 4 |
| Standardization | Yes | No |
| Weights | Trained | Stub [42.81, 0, 0, 0] |
| Alpha | 0.5 | 1.0 |

## Files
- `awb_ml_model.pkl.xz` — Trained ML model (decompress: `xz -d`)
- `awb.enc` / `awb.enc.xz` — Encrypted data/config
- `config.enc` / `config.enc.xz` — Encrypted config