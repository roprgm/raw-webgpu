# RAW loading benchmark

Measured September 9, 2026, on Apple M4 Pro, macOS 26.5.1, Chromium 151 and Bun 1.3.2 with vgpu 0.3.1.

Each row is one complete file from rawsamples.ch. The 30 originals remain in the ignored `.cache/rawsamples-30/raw/` directory. They are not distributed with the package.

Times are medians of three measured loads after one warmup, with an in-memory Blob, an existing device and decoder, and a fresh source/worker for every load. Loading includes native decoding/preparation, transfer, GPU upload and development, ending after GPU queue completion. Input download, disk read, device initialization, validation readback and PNG encoding are excluded. Browser and Bun runs were sequential. These are local observations, not an isolated performance laboratory.

The baseline is the earlier raw-webgpu build used for the original 30-camera test, not libraw-wasm. Other source changes, including shared WASM compilation, are also present in the new build; small differences do not isolate one optimization. X-Trans changed algorithms as well as execution backend.

| Camera / source file | File MB | Before, browser ms | Now, browser ms | Now, Bun ms | Demosaic |
| --- | ---: | ---: | ---: | ---: | --- |
| Canon EOS 5D Mark III · [RAW_CANON_EOS_5DMARK3.CR2](https://rawsamples.ch/raws/canon/RAW_CANON_EOS_5DMARK3.CR2) | 38.1 | 401 | 412 | 454 | gpu |
| Canon EOS 5DS · [RAW_CANON_EOS_5DS.CR2](https://rawsamples.ch/raws/canon/RAW_CANON_EOS_5DS.CR2) | 67.1 | 912 | 835 | 886 | gpu |
| Canon EOS 10D · [RAW_CANON_10D.CRW](https://rawsamples.ch/raws/canon/10d/RAW_CANON_10D.CRW) | 6.4 | 80 | 84 | 92 | gpu |
| Nikon D800 · [RAW_NIKON_D800_14bit_FX_LOSSLESS.NEF](https://rawsamples.ch/raws/nikon/RAW_NIKON_D800_14bit_FX_LOSSLESS.NEF) | 43.3 | 508 | 397 | 469 | gpu |
| Nikon D750 · [RAW_NIKON_D750.NEF](https://rawsamples.ch/raws/nikon/RAW_NIKON_D750.NEF) | 22.3 | 326 | 275 | 309 | gpu |
| Nikon D70 · [RAW_NIKON_D70.NEF](https://rawsamples.ch/raws/nikon/d70/RAW_NIKON_D70.NEF) | 5.5 | 73 | 73 | 88 | gpu |
| Sony Alpha 7R II · [RAW_SONY_ILCE-7RM2.ARW](https://rawsamples.ch/raws/sony/RAW_SONY_ILCE-7RM2.ARW) | 43.0 | Unsupported | 365 | 309 | gpu |
| Sony RX100 · [RAW_SONY_RX100.ARW](https://rawsamples.ch/raws/sony/RAW_SONY_RX100.ARW) | 20.9 | 128 | 141 | 152 | gpu |
| Sony Alpha 100 · [RAW_SONY_A100.ARW](https://rawsamples.ch/raws/sony/a100/RAW_SONY_A100.ARW) | 9.1 | 126 | 134 | 136 | gpu |
| Fujifilm X-Pro1 · [RAW_FUJI_XPRO1.RAF](https://rawsamples.ch/raws/fuji/RAW_FUJI_XPRO1.RAF) | 26.1 | 7582 | 240 | 290 | gpu |
| Fujifilm X-T10 · [RAW_FUJI_X-T10.RAF](https://rawsamples.ch/raws/fuji/RAW_FUJI_X-T10.RAF) | 33.8 | 7030 | 211 | 253 | gpu |
| Fujifilm S5 Pro · [RAW_FUJI_S5PRO_V106.RAF](https://rawsamples.ch/raws/fuji/s5pro/RAW_FUJI_S5PRO_V106.RAF) | 25.7 | Unsupported | 199 | 188 | cpu |
| Olympus E-M1 · [RAW_OLYMPUS_EM1.ORF](https://rawsamples.ch/raws/olympus/RAW_OLYMPUS_EM1.ORF) | 16.4 | 394 | 416 | 420 | gpu |
| Olympus E-1 · [RAW_OLYMPUS_E1.ORF](https://rawsamples.ch/raws/olympus/e1/RAW_OLYMPUS_E1.ORF) | 10.7 | 36 | 33 | 34 | gpu |
| Panasonic GH4 · [RAW_PANASONIC_DMC-GH4.RW2](https://rawsamples.ch/raws/panasonic/RAW_PANASONIC_DMC-GH4.RW2) | 19.9 | 121 | 132 | 161 | gpu |
| Panasonic FZ8 · [RAW_PANASONIC_FZ8.RAW](https://rawsamples.ch/raws/panasonic/fz8/RAW_PANASONIC_FZ8.RAW) | 11.6 | 52 | 58 | 58 | gpu |
| Pentax K-3 II · [RAW_PENTAX_K-3-II.PEF](https://rawsamples.ch/raws/pentax/RAW_PENTAX_K-3-II.PEF) | 33.2 | 251 | 275 | 317 | gpu |
| Pentax K-50 · [RAW_PENTAX_K50.DNG](https://rawsamples.ch/raws/pentax/RAW_PENTAX_K50.DNG) | 14.4 | 253 | 271 | 249 | gpu |
| Leica M Typ 240 · [RAW_LEICA_M240.DNG](https://rawsamples.ch/raws/leica/RAW_LEICA_M240.DNG) | 28.1 | 301 | 316 | 282 | gpu |
| Samsung NX500 · [RAW_SAMSUNG_NX500.SRW](https://rawsamples.ch/raws/samsung/RAW_SAMSUNG_NX500.SRW) | 46.3 | 347 | 371 | 388 | gpu |
| Sigma DP2 Quattro · [RAW_SIGMA_DP2-QUATTRO.X3F](https://rawsamples.ch/raws/sigma/RAW_SIGMA_DP2-QUATTRO.X3F) | 57.7 | Unsupported | 900 | 922 | none |
| Kodak DCS Pro · [RAW_KODAK_DCSPRO.DCR](https://rawsamples.ch/raws/kodak/dcs_pro/RAW_KODAK_DCSPRO.DCR) | 14.1 | 138 | 148 | 145 | gpu |
| Hasselblad H3DII-39 · [RAW_HASSELBLAD_H3D39II.3FR](https://rawsamples.ch/raws/hasselblad/h3d-39ii/RAW_HASSELBLAD_H3D39II.3FR) | 55.0 | 632 | 702 | 712 | gpu |
| Mamiya ZD · [RAW_MAMIYA_ZD.MEF](https://rawsamples.ch/raws/mamiya/zd/RAW_MAMIYA_ZD.MEF) | 36.6 | Unsupported | 180 | 177 | gpu |
| Minolta Dynax 7D · [RAW_MINOLTA_7D_SRGB.MRW](https://rawsamples.ch/raws/minolta/7d/RAW_MINOLTA_7D_SRGB.MRW) | 9.2 | 48 | 49 | 55 | gpu |
| Ricoh GR · [RAW_RICOH_GR.DNG](https://rawsamples.ch/raws/ricoh/RAW_RICOH_GR.DNG) | 11.3 | 230 | 233 | 219 | gpu |
| Epson R-D1 · [RAW_EPSON_RD1.ERF](https://rawsamples.ch/raws/epson/rd1/RAW_EPSON_RD1.ERF) | 10.0 | 48 | 54 | 57 | gpu |
| Leaf Aptus 22 · [RAW_LEAF_APTUS_22.MOS](https://rawsamples.ch/raws/leaf/aptus22/RAW_LEAF_APTUS_22.MOS) | 43.4 | 116 | 126 | 119 | gpu |
| OnePlus One · [RAW_ONEPLUS_ONE-A0001.DNG](https://rawsamples.ch/raws/phones/RAW_ONEPLUS_ONE-A0001.DNG) | 17.2 | Unsupported | 522 | 581 | cpu |
| Nokia Lumia 1020 · [RAW_NOKIA_LUMIA_1020.DNG](https://rawsamples.ch/raws/phones/RAW_NOKIA_LUMIA_1020.DNG) | 49.7 | Unsupported | 1719 | 2196 | cpu |

30/30 files converted in both runtimes. Bun checks all pixels for finite RGB and opaque alpha, verifies nonconstant content and 64 probes against retained PNG exports. The PNGs were encoded and round-trip checked during the preceding full-conversion run. Chromium checks finite output and 64 image probes against the Bun PNG, with a tolerance of 2/255. Embedded previews and full-resolution X-Trans crops were also visually inspected. These checks detect corruption; they are not a colorimetric certification for every camera.

## X-Trans quality and memory

The GPU implementation keeps the 6×6 mosaic as one uint16 channel and interpolates missing colors from a 7×7 neighborhood using inverse fourth-power distance weights. Each measured color sample is preserved. Bayer keeps MHC. The previous X-Trans path was LibRaw Markesteijn three-pass on one WASM CPU thread.

The simpler X-Trans interpolation softens fine detail and has different aliasing/false-color behavior. It is not quality-equivalent to Markesteijn. The original 16-bit four-channel source became a single-channel source, reducing the source texture by 75%; output and temporary allocations are separate. A separate camera-RGB float16 cache now prevents repeated demosaic during WB edits. It adds 8 bytes per pixel while retaining the 2-byte mosaic, so total source-owned texture storage is 10 bytes per pixel. Loading timings include creating this cache; output and temporary allocations are additional.

Comparison artifacts are retained in `.cache/rawsamples-30/gpu-pattern/`: `xtrans-comparison.jpg`, `quality-comparison.json`, per-file JSON measurements, exported PNGs, build hashes and the frozen build. SDR pixel differences from the previous PNG exports are around 3.6–3.8/255 on average; this is a difference measurement against another algorithm, not a ground-truth quality score.

## White balance updates

Full-resolution Chromium measurements: X-Pro1 render time fell from 127.0 ms to 0.9 ms, and X-T10 from 163.2 ms to 1.7 ms. Calibration took about 0.1 ms, with zero RAW reopen requests. Ten measured edits followed two warmups. Three white balances and 64 probes per image verified the cached result against the uncached calculation; maximum linear RGB difference was 0.00098, due to float16 cache rounding. The retained repro is `.cache/rawsamples-30/wb/benchmark.ts`, with baseline, cached and pixel-comparison JSON results. This measures the package GPU stage, not the full application frame rate.

## Compatibility

LibRaw prepares Fuji S5 geometry and Sigma X3F samples. The DNG SDK applies mandatory corrections to OnePlus One and Nokia Lumia 1020 files and returns normalized float camera RGB. White balance, color conversion and exposure remain on GPU. Bayer and X-Trans retain their mosaics.

The Sony A7R II, Mamiya ZD and Sigma DP2 Quattro samples lack usable as-shot multipliers through LibRaw. They use daylight calibration and report `whiteBalanceOrigin: "daylight"`; manual white balance remains available. Sigma color is experimental and does not match the camera JPEG.

WASM size: 1,814,296 bytes, compared with 1,796,148 bytes in the original benchmark. The build includes X3F support and DNG compatibility preparation.

Synthetic GPU/browser tests additionally cover all Bayer phases, six X-Trans phase shifts and borders, HDR float input, a mandatory GainMap with analytically known half-intensity output, white-balance restoration, orientation, invalid input and cancellation.
