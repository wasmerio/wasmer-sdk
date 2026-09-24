#pragma once
#include <setjmp.h>
/* Keep the saved frame in the caller, not WASIX libc's returned wrapper. */
#ifdef __wasm_exception_handling__
#define sigsetjmp(env, savesigs) setjmp(env)
#endif
