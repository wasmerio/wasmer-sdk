(module
  (import "wasi_snapshot_preview1" "fd_write"
    (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 32) "Hello from Swift!\n")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 32))
    (i32.store (i32.const 4) (i32.const 18))
    (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))
