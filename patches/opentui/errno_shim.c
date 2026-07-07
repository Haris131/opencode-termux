/* errno_shim.c
 * Provide __errno_location symbol for code compiled with glibc/musl headers.
 * Bionic does not export this symbol; NDK headers define it as static inline.
 */
#include <errno.h>

static __thread int __shim_errno = 0;

int *__errno_location(void) {
    return &__shim_errno;
}
