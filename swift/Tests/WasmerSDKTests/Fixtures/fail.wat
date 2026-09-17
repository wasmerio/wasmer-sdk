(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 32) "intentional failure\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.const 20))
    (drop (call $write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 8)))
    (call $exit (i32.const 7))))
