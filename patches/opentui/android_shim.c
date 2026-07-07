/* android_shim.c
 * Provides missing symbols when statically linking NDK libc++ with
 * Bionic libc on older Android API levels.
 *
 * NDK libc++_static.a references functions that exist in NDK API 29+
 * but may not be available on API 24-28. These stubs ensure the .so
 * loads correctly even on older Android versions.
 */

#include <errno.h>
#include <stddef.h>
#include <sys/types.h>
#include <unistd.h>

/* ===== __errno_location (glibc compat) ===== */
static __thread int __shim_errno = 0;
int *__errno_location(void) { return &__shim_errno; }

/* ===== copy_file_range (API 34+) ===== */
ssize_t copy_file_range(int, off64_t *, int, off64_t *, size_t, unsigned int) {
    errno = ENOSYS;
    return -1;
}

/* ===== close_range (API 30+) ===== */
int close_range(unsigned int, unsigned int, int) {
    errno = ENOSYS;
    return -1;
}
