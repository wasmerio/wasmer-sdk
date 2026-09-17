(module
  (import "wasi_snapshot_preview1" "fd_read"
    (func $read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write"
    (func $write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 32))
    (block $done (loop $again
      (i32.store (i32.const 4) (i32.const 1024))
      (drop (call $read (i32.const 0) (i32.const 0) (i32.const 1) (i32.const 8)))
      (br_if $done (i32.eqz (i32.load (i32.const 8))))
      (i32.store (i32.const 4) (i32.load (i32.const 8)))
      (drop (call $write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 12)))
      (br $again)))))
