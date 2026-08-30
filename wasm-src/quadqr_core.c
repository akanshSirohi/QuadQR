#include <stdint.h>
#include <stddef.h>

void *memset(void *dest, int value, size_t count) {
  uint8_t *out = (uint8_t *)dest;
  for (size_t i = 0; i < count; i++) out[i] = (uint8_t)value;
  return dest;
}


// QuadQR's dependency-free optional WASM accelerator. The JavaScript scanner
// remains the compatibility fallback, while hot byte/pixel loops can be
// installed after initWasm().
__attribute__((visibility("default")))
uint32_t crc32_bytes(const uint8_t *data, uint32_t len) {
  uint32_t crc = 0xffffffffu;
  for (uint32_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint32_t bit = 0; bit < 8; bit++) {
      uint32_t mask = (uint32_t)-(int32_t)(crc & 1u);
      crc = (crc >> 1) ^ (0xedb88320u & mask);
    }
  }
  return crc ^ 0xffffffffu;
}

static inline uint8_t clamp_threshold(int32_t value) {
  if (value < 8) return 8;
  if (value > 247) return 247;
  return (uint8_t)value;
}

static uint8_t otsu_threshold_u8(const uint8_t *gray, uint32_t len) {
  uint32_t histogram[256] = {0};
  uint64_t sum = 0;
  for (uint32_t i = 0; i < len; i++) {
    const uint8_t value = gray[i];
    histogram[value]++;
    sum += (uint64_t)value;
  }

  uint64_t sum_background = 0;
  uint32_t weight_background = 0;
  double max_variance = -1.0;
  uint8_t threshold = 127;

  for (uint32_t t = 0; t < 256; t++) {
    weight_background += histogram[t];
    if (weight_background == 0) continue;
    const uint32_t weight_foreground = len - weight_background;
    if (weight_foreground == 0) break;
    sum_background += (uint64_t)t * histogram[t];
    const double mean_background = (double)sum_background / (double)weight_background;
    const double mean_foreground = (double)(sum - sum_background) / (double)weight_foreground;
    const double diff = mean_background - mean_foreground;
    const double variance = (double)weight_background * (double)weight_foreground * diff * diff;
    if (variance > max_variance) {
      max_variance = variance;
      threshold = (uint8_t)t;
    }
  }
  return threshold;
}

// Convert RGBA pixels to the scanner's grayscale representation, compute the
// Otsu threshold, and create the binary finder image in one WASM call.
// mode: 0 = RGB value/max channel, 1 = luminance.
// Return value packs base Otsu threshold in bits 8..15 and final threshold in
// bits 0..7 so JS does not need another pass over the histogram.
__attribute__((visibility("default")))
uint32_t build_binary_rgba(
  const uint8_t *rgba,
  uint32_t pixels,
  uint32_t mode,
  int32_t threshold_offset,
  uint8_t *gray,
  uint8_t *binary
) {
  for (uint32_t i = 0; i < pixels; i++) {
    const uint32_t p = i * 4u;
    const uint32_t a = rgba[p + 3u];
    const uint32_t inverse_a = 255u - a;

    // Keep alpha compositing mathematically equivalent to compositing against
    // white in the JS scanner. Numerators remain scaled by 255 until the final
    // rounding, which avoids losing precision on transparent image scans.
    const uint32_t rn = (uint32_t)rgba[p] * a + 255u * inverse_a;
    const uint32_t gn = (uint32_t)rgba[p + 1u] * a + 255u * inverse_a;
    const uint32_t bn = (uint32_t)rgba[p + 2u] * a + 255u * inverse_a;

    uint32_t value;
    if (mode == 0u) {
      uint32_t maxn = rn > gn ? rn : gn;
      if (bn > maxn) maxn = bn;
      value = (maxn + 127u) / 255u;
    } else {
      // Same Rec.709 coefficients as JS: 0.2126, 0.7152, 0.0722.
      const uint64_t weighted = (uint64_t)2126u * rn + (uint64_t)7152u * gn + (uint64_t)722u * bn;
      value = (uint32_t)((weighted + 1275000ull) / 2550000ull);
    }
    gray[i] = (uint8_t)(value > 255u ? 255u : value);
  }

  const uint8_t base = otsu_threshold_u8(gray, pixels);
  const uint8_t threshold = clamp_threshold((int32_t)base + threshold_offset);
  for (uint32_t i = 0; i < pixels; i++) binary[i] = gray[i] <= threshold ? 1u : 0u;
  return ((uint32_t)base << 8u) | (uint32_t)threshold;
}
