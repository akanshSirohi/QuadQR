#include <stdint.h>
#include <stddef.h>

// Small dependency-free helper used as an optional accelerator after initWasm().
// QuadQR never requires WASM to encode/decode; the JavaScript path is always kept
// as a portable fallback. Keeping the ABI tiny also makes CDN loading reliable.
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
