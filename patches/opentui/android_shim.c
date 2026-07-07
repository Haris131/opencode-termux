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
/* off64_t does not exist in musl headers; use off_t (64-bit on LP64). */
ssize_t copy_file_range(int fd_in, off_t *off_in, int fd_out, off_t *off_out, size_t len, unsigned int flags) {
    (void)fd_in; (void)off_in; (void)fd_out; (void)off_out; (void)len; (void)flags;
    errno = ENOSYS;
    return -1;
}

/* ===== close_range (API 30+) ===== */
int close_range(unsigned int first, unsigned int last, int flags) {
    (void)first; (void)last; (void)flags;
    errno = ENOSYS;
    return -1;
}
