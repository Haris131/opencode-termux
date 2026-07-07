/* locale_shim.h
 * Provides locale_t function declarations missing when using NDK libc++
 * headers with a non-NDK C library (musl).
 *
 * NDK libc++ <locale> uses strtoll_l/strtoull_l which are Bionic functions.
 * These stubs call the locale-independent strtoll/strtoull (safe for yoga). */
#ifndef LOCALE_SHIM_H
#define LOCALE_SHIM_H

#include <stdlib.h>

#if !defined(__BIONIC__) && !defined(strtoll_l)
static inline long long strtoll_l(const char* nptr, char** endptr, int base, void* loc) {
    (void)loc;
    return strtoll(nptr, endptr, base);
}
static inline unsigned long long strtoull_l(const char* nptr, char** endptr, int base, void* loc) {
    (void)loc;
    return strtoull(nptr, endptr, base);
}
#endif

#endif
