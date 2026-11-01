## Synthetic set (exact ground truth)

### Rhythm
| name | bpm_ref | bpm_est | tempo_acc1 | tempo_acc2 | beat_f | downbeat_f | meter_ok |
|---|---|---|---|---|---|---|---|
| dnb | 174 | 175.19 | 1.00 | 1.00 | 0.99 | 0.99 | 1.00 |
| edm_drop | 128 | 129.20 | 1.00 | 1.00 | 0.92 | 0.91 | 1.00 |
| house_groove | 122 | 123.05 | 1.00 | 1.00 | 0.91 | 0.91 | 1.00 |
| lofi_swing | 88 | 87.59 | 1.00 | 1.00 | 0.96 | 0.96 | 1.00 |
| pop_ballad | 76 | 152.00 | 0.00 | 1.00 | 0.66 | 0.65 | 1.00 |
| tempo_ramp | 110 | 109.96 | 1.00 | 1.00 | 0.99 | 0.99 | 1.00 |
| waltz | 150 | 152.00 | 1.00 | 1.00 | 0.99 | 0.99 | 1.00 |
| **mean** |  |  | **0.86** | **1.00** | **0.92** | **0.91** | **1.00** |

### Harmony
| name | key_ref | key_est | key_score | chord_majmin | chord_root |
|---|---|---|---|---|---|
| dnb | D minor | D minor | 1.00 | 0.92 | 0.92 |
| edm_drop | F minor | F minor | 1.00 | 0.79 | 0.79 |
| house_groove | A minor | A minor | 1.00 | 0.92 | 0.92 |
| lofi_swing | A# major | A# major | 1.00 | 0.74 | 0.74 |
| pop_ballad | D# major | D# major | 1.00 | 0.94 | 0.94 |
| tempo_ramp | C major | C major | 1.00 | 0.95 | 0.95 |
| waltz | G major | G major | 1.00 | 0.77 | 0.77 |
| **mean** |  |  | **1.00** | **0.86** | **0.86** |

### Structure and stems
| name | boundary_f3 | boundary_p3 | boundary_r3 | label_function | label_exact | stem_drums | stem_bass | stem_other | seconds |
|---|---|---|---|---|---|---|---|---|---|
| dnb | 1.00 | 1.00 | 1.00 | 1.00 | 1.00 | 0.82 | 0.99 | 0.99 | 25.96 |
| edm_drop | 0.55 | 0.60 | 0.50 | 0.74 | 0.74 | 0.82 | 0.79 | 0.99 | 21.93 |
| house_groove | 0.67 | 0.75 | 0.60 | 0.71 | 0.24 | 0.89 | 0.83 | 0.99 | 25.40 |
| lofi_swing | 1.00 | 1.00 | 1.00 | 0.95 | 0.95 | 0.90 | 0.95 | 0.99 | 18.08 |
| pop_ballad | 0.71 | 0.62 | 0.83 | 0.91 | 0.84 | 0.99 | 0.99 | 0.99 | 24.61 |
| tempo_ramp | 1.00 | 1.00 | 1.00 | 0.15 | 0.15 | 0.92 | 0.98 | 0.99 | 17.08 |
| waltz | 1.00 | 1.00 | 1.00 | 0.97 | 0.97 | 0.89 | 0.99 | 0.99 | 14.28 |
| **mean** | **0.85** | **0.85** | **0.85** | **0.78** | **0.70** | **0.89** | **0.93** | **0.99** |  |

## Real recordings (published truth only)

| name | bpm_est | meter_ok | key_ref | key_est | key_score | key_score_alt | stem_drums | stem_bass | stem_other | seconds |
|---|---|---|---|---|---|---|---|---|---|---|
| brahms_hungarian5 | 147.66 |  | F# minor | G minor | 0.00 | 1.00 |  |  |  | 7.13 |
| sugar_plum_fairy | 109.96 |  | E minor | E minor | 1.00 |  |  |  |  | 20.03 |
| sweet_waltz | 152.00 | 1.00 |  |  |  |  |  |  |  | 6.94 |
| vibe_ace | 129.20 |  |  |  |  |  |  |  |  | 9.94 |
| choice_drum_bass | 136.00 |  |  |  |  |  |  |  |  | 4.13 |
| pistachio_rag | 143.55 |  |  |  |  |  |  |  |  | 10.59 |
| outfoxing_the_fox | 161.50 |  |  |  |  |  |  |  |  | 16.76 |
| mdn_multitrack | 152.00 |  |  |  |  |  | 0.95 | 0.97 | 1.00 | 13.35 |
| **mean** |  | **1.00** |  |  | **0.50** | **1.00** | **0.95** | **0.97** | **1.00** |  |
