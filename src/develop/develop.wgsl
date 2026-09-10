// Sensor samples in, unclipped linear Rec.2020 out: normalize, white balance,
// demosaic when needed, correct vignetting, convert color and apply exposure.

struct Sensor {
  black: vec4f,
  patternSize: vec4u,
  white: f32,
  flip: u32,
  mosaic: u32,
  floating: u32,
}

struct Calibration {
  gains: vec3f,
  exposure: f32,
  matrix: mat3x3f,
}

struct Vignette {
  coefficients: vec4f,
  origin: vec2f,
  step: vec2f,
  last: f32,
}

@group(0) @binding(0) var source: texture_2d<u32>;
@group(0) @binding(1) var<uniform> sensor: Sensor;
@group(0) @binding(2) var<uniform> calibration: Calibration;
@group(0) @binding(3) var<uniform> vignette: Vignette;

@group(0) @binding(4) var<uniform> pattern: array<vec4u, 9>;

// CFA color index at a sensor position: R=0, G=1 or 3, B=2.
fn channel(p: vec2i) -> u32 {
  if (sensor.patternSize.x == 2u) {
    return pattern[0][(p.y & 1) * 2 + (p.x & 1)];
  }
  let side = i32(sensor.patternSize.x);
  let q = (p % side + side) % side;
  let i = u32(q.y * side + q.x);
  return pattern[i / 4u][i % 4u];
}

// One normalized, white-balanced sample; both greens share the green gain.
fn sample(p: vec2i, size: vec2i) -> f32 {
  // Reflect at the border without changing CFA parity.
  let q = min(abs(p), 2 * (size - 1) - p);
  let c = channel(q);
  let value = f32(textureLoad(source, q, 0).r);
  let gain = calibration.gains[select(c, 1u, c == 3u)];
  return max(value - sensor.black[c], 0.0) / (sensor.white - sensor.black[c]) * gain;
}

// Malvar, He and Cutler, ICASSP 2004, Fig. 2: gradient-corrected 5x5 Bayer filters.
fn demosaic(p: vec2i, size: vec2i) -> vec3f {
  let center = sample(p, size);
  let horizontal = sample(p + vec2i(-1, 0), size) + sample(p + vec2i(1, 0), size);
  let vertical = sample(p + vec2i(0, -1), size) + sample(p + vec2i(0, 1), size);
  let horizontal2 = sample(p + vec2i(-2, 0), size) + sample(p + vec2i(2, 0), size);
  let vertical2 = sample(p + vec2i(0, -2), size) + sample(p + vec2i(0, 2), size);
  let diagonal = sample(p + vec2i(-1, -1), size) + sample(p + vec2i(1, -1), size)
    + sample(p + vec2i(-1, 1), size) + sample(p + vec2i(1, 1), size);
  let c = channel(p);

  // At a red or blue site: green from the cross, the opposite color from the diagonals.
  if (c == 0u || c == 2u) {
    let green = (4.0 * center + 2.0 * (horizontal + vertical) - horizontal2 - vertical2) / 8.0;
    let opposite = (6.0 * center + 2.0 * diagonal - 1.5 * (horizontal2 + vertical2)) / 8.0;
    return select(vec3f(opposite, green, center), vec3f(center, green, opposite), c == 0u);
  }

  // At a green site: the color of the row neighbors uses the row filter, the other the column filter.
  let across = (5.0 * center + 4.0 * horizontal - horizontal2 - diagonal + 0.5 * vertical2) / 8.0;
  let along = (5.0 * center + 4.0 * vertical - vertical2 - diagonal + 0.5 * horizontal2) / 8.0;
  return select(vec3f(along, center, across), vec3f(across, center, along), channel(p + vec2i(1, 0)) == 0u);
}

// Normalized convolution for larger RGB mosaics. Preserve the measured channel and
// reconstruct missing colors from nearby sites, weighted by inverse fourth-power distance.
fn demosaicPattern(p: vec2i, size: vec2i) -> vec3f {
  var sum = vec3f(0.0);
  var weight = vec3f(0.0);
  for (var y = -3; y <= 3; y++) {
    for (var x = -3; x <= 3; x++) {
      let q = p + vec2i(x, y);
      if (any(q < vec2i(0)) || any(q >= size)) { continue; }
      let c = channel(q);
      let rgb = select(c, 1u, c == 3u);
      let distance2 = f32(max(x * x + y * y, 1));
      let w = 1.0 / (distance2 * distance2);
      sum[rgb] += sample(q, size) * w;
      weight[rgb] += w;
    }
  }
  var color = sum / max(weight, vec3f(0.00001));
  let c = channel(p);
  color[select(c, 1u, c == 3u)] = sample(p, size);
  return color;
}

@fragment fn fs_main(@builtin(position) position: vec4f) -> @location(0) vec4f {
  // Map the oriented output pixel back to its sensor position.
  let size = vec2i(textureDimensions(source));
  var p = vec2i(position.xy);
  if ((sensor.flip & 4u) != 0u) { p = p.yx; }
  if ((sensor.flip & 2u) != 0u) { p.y = size.y - 1 - p.y; }
  if ((sensor.flip & 1u) != 0u) { p.x = size.x - 1 - p.x; }

  var camera: vec3f;
  if (sensor.mosaic != 0u) {
    if (sensor.patternSize.x == 2u) {
      camera = demosaic(p, size);
    } else {
      camera = demosaicPattern(p, size);
    }
  } else {
    let bits = textureLoad(source, p, 0).rgb;
    let value = select(vec3f(bits), bitcast<vec3f>(bits), sensor.floating != 0u);
    camera = max(value - sensor.black.rgb, vec3f(0.0))
      / (vec3f(sensor.white) - sensor.black.rgb) * calibration.gains;
  }

  // DNG FixVignetteRadial: a polynomial in r² over normalized coordinates.
  let q = (vec2f(p) + 0.5) * vignette.step + vignette.origin;
  let r2 = dot(q, q);
  let k = vignette.coefficients;
  let gain = 1.0 + r2 * (k.x + r2 * (k.y + r2 * (k.z + r2 * (k.w + r2 * vignette.last))));

  return vec4f(calibration.matrix * camera * gain * calibration.exposure, 1.0);
}

@group(0) @binding(5) var cameraSource: texture_2d<f32>;

// Refine a neutral camera-RGB estimate by interpolating color differences.
// The denser green samples carry detail into red and blue without repeating
// this reconstruction when white balance changes.
@fragment fn fs_refine(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(source));
  var p = vec2i(position.xy);
  if ((sensor.flip & 4u) != 0u) { p = p.yx; }
  if ((sensor.flip & 2u) != 0u) { p.y = size.y - 1 - p.y; }
  if ((sensor.flip & 1u) != 0u) { p.x = size.x - 1 - p.x; }
  let center = textureLoad(cameraSource, vec2i(position.xy), 0).rgb;
  var difference = vec3f(0.0);
  var weight = vec3f(0.0);
  for (var y = -3; y <= 3; y++) {
    for (var x = -3; x <= 3; x++) {
      let q = p + vec2i(x, y);
      if (any(q < vec2i(0)) || any(q >= size)) { continue; }
      let c = channel(q);
      if (c != 0u && c != 2u) { continue; }
      var oriented = q;
      if ((sensor.flip & 1u) != 0u) { oriented.x = size.x - 1 - oriented.x; }
      if ((sensor.flip & 2u) != 0u) { oriented.y = size.y - 1 - oriented.y; }
      if ((sensor.flip & 4u) != 0u) { oriented = oriented.yx; }
      let rgb = textureLoad(cameraSource, oriented, 0).rgb;
      let distance2 = f32(max(x * x + y * y, 1));
      let w = 1.0 / (distance2 * distance2);
      difference[c] += (rgb[c] - rgb.g) * w;
      weight[c] += w;
    }
  }
  var color = center.g + difference / max(weight, vec3f(0.00001));
  let c = channel(p);
  color[select(c, 1u, c == 3u)] = center[select(c, 1u, c == 3u)];
  return vec4f(calibration.matrix * color * calibration.exposure, 1.0);
}

// Cached X-Trans camera RGB: subsequent edits only apply per-pixel linear transforms.
@fragment fn fs_camera(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let camera = textureLoad(cameraSource, vec2i(position.xy), 0).rgb;
  return vec4f(calibration.matrix * (camera * calibration.gains) * calibration.exposure, 1.0);
}

// One triangle covering the whole destination.
@vertex fn vs_main(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let points = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  return vec4f(points[index], 0, 1);
}
