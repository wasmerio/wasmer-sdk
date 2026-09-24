package wasmer_sdk_uniffi

// #include <wasmer_sdk_uniffi.h>
import "C"

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"reflect"
	"runtime"
	"runtime/cgo"
	"sync/atomic"
	"unsafe"
)

// This is needed, because as of go 1.24
// type RustBuffer C.RustBuffer cannot have methods,
// RustBuffer is treated as non-local type
type GoRustBuffer struct {
	inner C.RustBuffer
}

type RustBufferI interface {
	AsReader() *bytes.Reader
	Free()
	ToGoBytes() []byte
	Data() unsafe.Pointer
	Len() uint64
	Capacity() uint64
}

// C.RustBuffer fields exposed as an interface so they can be accessed in different Go packages.
// See https://github.com/golang/go/issues/13467
type ExternalCRustBuffer interface {
	Data() unsafe.Pointer
	Len() uint64
	Capacity() uint64
}

func RustBufferFromC(b C.RustBuffer) ExternalCRustBuffer {
	return GoRustBuffer{
		inner: b,
	}
}

func CFromRustBuffer(b ExternalCRustBuffer) C.RustBuffer {
	return C.RustBuffer{
		capacity: C.uint64_t(b.Capacity()),
		len:      C.uint64_t(b.Len()),
		data:     (*C.uchar)(b.Data()),
	}
}

func RustBufferFromExternal(b ExternalCRustBuffer) GoRustBuffer {
	return GoRustBuffer{
		inner: C.RustBuffer{
			capacity: C.uint64_t(b.Capacity()),
			len:      C.uint64_t(b.Len()),
			data:     (*C.uchar)(b.Data()),
		},
	}
}

func (cb GoRustBuffer) Capacity() uint64 {
	return uint64(cb.inner.capacity)
}

func (cb GoRustBuffer) Len() uint64 {
	return uint64(cb.inner.len)
}

func (cb GoRustBuffer) Data() unsafe.Pointer {
	return unsafe.Pointer(cb.inner.data)
}

func (cb GoRustBuffer) AsReader() *bytes.Reader {
	b := unsafe.Slice((*byte)(cb.inner.data), C.uint64_t(cb.inner.len))
	return bytes.NewReader(b)
}

func (cb GoRustBuffer) Free() {
	rustCall(func(status *C.RustCallStatus) bool {
		C.ffi_wasmer_sdk_uniffi_rustbuffer_free(cb.inner, status)
		return false
	})
}

func (cb GoRustBuffer) ToGoBytes() []byte {
	return C.GoBytes(unsafe.Pointer(cb.inner.data), C.int(cb.inner.len))
}

func stringToRustBuffer(str string) C.RustBuffer {
	return bytesToRustBuffer([]byte(str))
}

func bytesToRustBuffer(b []byte) C.RustBuffer {
	if len(b) == 0 {
		return C.RustBuffer{}
	}
	// We can pass the pointer along here, as it is pinned
	// for the duration of this call
	foreign := C.ForeignBytes{
		len:  C.int(len(b)),
		data: (*C.uchar)(unsafe.Pointer(&b[0])),
	}

	return rustCall(func(status *C.RustCallStatus) C.RustBuffer {
		return C.ffi_wasmer_sdk_uniffi_rustbuffer_from_bytes(foreign, status)
	})
}

type BufLifter[GoType any] interface {
	Lift(value RustBufferI) GoType
}

type BufLowerer[GoType any] interface {
	Lower(value GoType) C.RustBuffer
}

type BufReader[GoType any] interface {
	Read(reader io.Reader) GoType
}

type BufWriter[GoType any] interface {
	Write(writer io.Writer, value GoType)
}

func LowerIntoRustBuffer[GoType any](bufWriter BufWriter[GoType], value GoType) C.RustBuffer {
	// This might be not the most efficient way but it does not require knowing allocation size
	// beforehand
	var buffer bytes.Buffer
	bufWriter.Write(&buffer, value)

	bytes, err := io.ReadAll(&buffer)
	if err != nil {
		panic(fmt.Errorf("reading written data: %w", err))
	}
	return bytesToRustBuffer(bytes)
}

func LiftFromRustBuffer[GoType any](bufReader BufReader[GoType], rbuf RustBufferI) GoType {
	defer rbuf.Free()
	reader := rbuf.AsReader()
	item := bufReader.Read(reader)
	if reader.Len() > 0 {
		// TODO: Remove this
		leftover, _ := io.ReadAll(reader)
		panic(fmt.Errorf("Junk remaining in buffer after lifting: %s", string(leftover)))
	}
	return item
}

func rustCallWithError[E any, U any](converter BufReader[E], callback func(*C.RustCallStatus) U) (U, E) {
	var status C.RustCallStatus
	returnValue := callback(&status)
	err := checkCallStatus(converter, status)
	return returnValue, err
}

func checkCallStatus[E any](converter BufReader[E], status C.RustCallStatus) E {
	switch status.code {
	case 0:
		var zero E
		return zero
	case 1:
		return LiftFromRustBuffer(converter, GoRustBuffer{inner: status.errorBuf})
	case 2:
		// when the rust code sees a panic, it tries to construct a rustBuffer
		// with the message.  but if that code panics, then it just sends back
		// an empty buffer.
		if status.errorBuf.len > 0 {
			panic(fmt.Errorf("%s", FfiConverterStringINSTANCE.Lift(GoRustBuffer{inner: status.errorBuf})))
		} else {
			panic(fmt.Errorf("Rust panicked while handling Rust panic"))
		}
	default:
		panic(fmt.Errorf("unknown status code: %d", status.code))
	}
}

func checkCallStatusUnknown(status C.RustCallStatus) error {
	switch status.code {
	case 0:
		return nil
	case 1:
		panic(fmt.Errorf("function not returning an error returned an error"))
	case 2:
		// when the rust code sees a panic, it tries to construct a C.RustBuffer
		// with the message.  but if that code panics, then it just sends back
		// an empty buffer.
		if status.errorBuf.len > 0 {
			panic(fmt.Errorf("%s", FfiConverterStringINSTANCE.Lift(GoRustBuffer{
				inner: status.errorBuf,
			})))
		} else {
			panic(fmt.Errorf("Rust panicked while handling Rust panic"))
		}
	default:
		return fmt.Errorf("unknown status code: %d", status.code)
	}
}

func rustCall[U any](callback func(*C.RustCallStatus) U) U {
	returnValue, err := rustCallWithError[error](nil, callback)
	if err != nil {
		panic(err)
	}
	return returnValue
}

type NativeError interface {
	AsError() error
}

func writeInt8(writer io.Writer, value int8) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeUint8(writer io.Writer, value uint8) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeInt16(writer io.Writer, value int16) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeUint16(writer io.Writer, value uint16) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeInt32(writer io.Writer, value int32) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeUint32(writer io.Writer, value uint32) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeInt64(writer io.Writer, value int64) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeUint64(writer io.Writer, value uint64) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeFloat32(writer io.Writer, value float32) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func writeFloat64(writer io.Writer, value float64) {
	if err := binary.Write(writer, binary.BigEndian, value); err != nil {
		panic(err)
	}
}

func readInt8(reader io.Reader) int8 {
	var result int8
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readUint8(reader io.Reader) uint8 {
	var result uint8
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readInt16(reader io.Reader) int16 {
	var result int16
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readUint16(reader io.Reader) uint16 {
	var result uint16
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readInt32(reader io.Reader) int32 {
	var result int32
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readUint32(reader io.Reader) uint32 {
	var result uint32
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readInt64(reader io.Reader) int64 {
	var result int64
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readUint64(reader io.Reader) uint64 {
	var result uint64
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readFloat32(reader io.Reader) float32 {
	var result float32
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func readFloat64(reader io.Reader) float64 {
	var result float64
	if err := binary.Read(reader, binary.BigEndian, &result); err != nil {
		panic(err)
	}
	return result
}

func init() {

	uniffiCheckChecksums()
}

func uniffiCheckChecksums() {
	// Get the bindings contract version from our ComponentInterface
	bindingsContractVersion := 30
	// Get the scaffolding contract version by calling the into the dylib
	scaffoldingContractVersion := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint32_t {
		return C.ffi_wasmer_sdk_uniffi_uniffi_contract_version()
	})
	if bindingsContractVersion != int(scaffoldingContractVersion) {
		// If this happens try cleaning and rebuilding your project
		panic("wasmer_sdk_uniffi: UniFFI contract version mismatch")
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_commandcore_run()
		})
		if checksum != 5902 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_commandcore_run: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_commandcore_spawn()
		})
		if checksum != 43473 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_commandcore_spawn: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_commandrefcore_name()
		})
		if checksum != 34603 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_commandrefcore_name: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_mkdir()
		})
		if checksum != 59020 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_mkdir: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_read()
		})
		if checksum != 25079 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_read: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_read_dir()
		})
		if checksum != 5736 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_read_dir: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_remove()
		})
		if checksum != 7597 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_remove: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_rename()
		})
		if checksum != 49060 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_rename: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_stat()
		})
		if checksum != 1899 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_stat: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_write()
		})
		if checksum != 14244 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_filesystemcore_write: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_command()
		})
		if checksum != 41905 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_command: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_commands()
		})
		if checksum != 49483 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_commands: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_entrypoint()
		})
		if checksum != 41248 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_entrypoint: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_id()
		})
		if checksum != 60275 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_packagecore_id: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_portscore_wait()
		})
		if checksum != 1470 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_portscore_wait: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_close_stdin()
		})
		if checksum != 65526 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_close_stdin: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_has_stderr()
		})
		if checksum != 7103 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_has_stderr: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_has_stdin()
		})
		if checksum != 5339 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_has_stdin: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_has_stdout()
		})
		if checksum != 32179 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_has_stdout: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_id()
		})
		if checksum != 54443 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_id: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_kill()
		})
		if checksum != 10613 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_kill: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_read_stderr()
		})
		if checksum != 53741 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_read_stderr: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_read_stdout()
		})
		if checksum != 14265 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_read_stdout: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_terminate()
		})
		if checksum != 43333 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_terminate: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_wait()
		})
		if checksum != 63991 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_wait: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_processcore_write_stdin()
		})
		if checksum != 61505 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_processcore_write_stdin: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_close()
		})
		if checksum != 60556 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_close: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_command_name()
		})
		if checksum != 30603 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_command_name: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_command_package()
		})
		if checksum != 53325 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_command_package: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_command_ref()
		})
		if checksum != 59632 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_command_ref: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_filesystem()
		})
		if checksum != 47323 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_filesystem: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_bytes()
		})
		if checksum != 11977 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_bytes: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_path()
		})
		if checksum != 59537 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_path: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_ref()
		})
		if checksum != 21258 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_ref: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_registry()
		})
		if checksum != 25074 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_install_package_registry: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_ports()
		})
		if checksum != 270 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_sandboxcore_ports: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_close()
		})
		if checksum != 31079 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_close: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_create_package()
		})
		if checksum != 41785 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_create_package: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_create_sandbox()
		})
		if checksum != 28086 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_create_sandbox: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_load_package_bytes()
		})
		if checksum != 22637 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_load_package_bytes: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_load_package_path()
		})
		if checksum != 58200 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_load_package_path: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_load_package_registry()
		})
		if checksum != 55322 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_method_wasmercore_load_package_registry: UniFFI API checksum mismatch")
		}
	}
	{
		checksum := rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint16_t {
			return C.uniffi_wasmer_sdk_uniffi_checksum_constructor_wasmercore_new()
		})
		if checksum != 60050 {
			// If this happens try cleaning and rebuilding your project
			panic("wasmer_sdk_uniffi: uniffi_wasmer_sdk_uniffi_checksum_constructor_wasmercore_new: UniFFI API checksum mismatch")
		}
	}
}

type FfiConverterUint16 struct{}

var FfiConverterUint16INSTANCE = FfiConverterUint16{}

func (FfiConverterUint16) Lower(value uint16) C.uint16_t {
	return C.uint16_t(value)
}

func (FfiConverterUint16) Write(writer io.Writer, value uint16) {
	writeUint16(writer, value)
}

func (FfiConverterUint16) Lift(value C.uint16_t) uint16 {
	return uint16(value)
}

func (FfiConverterUint16) Read(reader io.Reader) uint16 {
	return readUint16(reader)
}

type FfiDestroyerUint16 struct{}

func (FfiDestroyerUint16) Destroy(_ uint16) {}

type FfiConverterUint32 struct{}

var FfiConverterUint32INSTANCE = FfiConverterUint32{}

func (FfiConverterUint32) Lower(value uint32) C.uint32_t {
	return C.uint32_t(value)
}

func (FfiConverterUint32) Write(writer io.Writer, value uint32) {
	writeUint32(writer, value)
}

func (FfiConverterUint32) Lift(value C.uint32_t) uint32 {
	return uint32(value)
}

func (FfiConverterUint32) Read(reader io.Reader) uint32 {
	return readUint32(reader)
}

type FfiDestroyerUint32 struct{}

func (FfiDestroyerUint32) Destroy(_ uint32) {}

type FfiConverterInt32 struct{}

var FfiConverterInt32INSTANCE = FfiConverterInt32{}

func (FfiConverterInt32) Lower(value int32) C.int32_t {
	return C.int32_t(value)
}

func (FfiConverterInt32) Write(writer io.Writer, value int32) {
	writeInt32(writer, value)
}

func (FfiConverterInt32) Lift(value C.int32_t) int32 {
	return int32(value)
}

func (FfiConverterInt32) Read(reader io.Reader) int32 {
	return readInt32(reader)
}

type FfiDestroyerInt32 struct{}

func (FfiDestroyerInt32) Destroy(_ int32) {}

type FfiConverterUint64 struct{}

var FfiConverterUint64INSTANCE = FfiConverterUint64{}

func (FfiConverterUint64) Lower(value uint64) C.uint64_t {
	return C.uint64_t(value)
}

func (FfiConverterUint64) Write(writer io.Writer, value uint64) {
	writeUint64(writer, value)
}

func (FfiConverterUint64) Lift(value C.uint64_t) uint64 {
	return uint64(value)
}

func (FfiConverterUint64) Read(reader io.Reader) uint64 {
	return readUint64(reader)
}

type FfiDestroyerUint64 struct{}

func (FfiDestroyerUint64) Destroy(_ uint64) {}

type FfiConverterBool struct{}

var FfiConverterBoolINSTANCE = FfiConverterBool{}

func (FfiConverterBool) Lower(value bool) C.int8_t {
	if value {
		return C.int8_t(1)
	}
	return C.int8_t(0)
}

func (FfiConverterBool) Write(writer io.Writer, value bool) {
	if value {
		writeInt8(writer, 1)
	} else {
		writeInt8(writer, 0)
	}
}

func (FfiConverterBool) Lift(value C.int8_t) bool {
	return value != 0
}

func (FfiConverterBool) Read(reader io.Reader) bool {
	return readInt8(reader) != 0
}

type FfiDestroyerBool struct{}

func (FfiDestroyerBool) Destroy(_ bool) {}

type FfiConverterString struct{}

var FfiConverterStringINSTANCE = FfiConverterString{}

func (FfiConverterString) Lift(rb RustBufferI) string {
	defer rb.Free()
	reader := rb.AsReader()
	b, err := io.ReadAll(reader)
	if err != nil {
		panic(fmt.Errorf("reading reader: %w", err))
	}
	return string(b)
}

func (FfiConverterString) Read(reader io.Reader) string {
	length := readInt32(reader)
	buffer := make([]byte, length)
	read_length, err := reader.Read(buffer)
	if err != nil && err != io.EOF {
		panic(err)
	}
	if read_length != int(length) {
		panic(fmt.Errorf("bad read length when reading string, expected %d, read %d", length, read_length))
	}
	return string(buffer)
}

func (FfiConverterString) Lower(value string) C.RustBuffer {
	return stringToRustBuffer(value)
}

func (c FfiConverterString) LowerExternal(value string) ExternalCRustBuffer {
	return RustBufferFromC(stringToRustBuffer(value))
}

func (FfiConverterString) Write(writer io.Writer, value string) {
	if len(value) > math.MaxInt32 {
		panic("String is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(value)))
	write_length, err := io.WriteString(writer, value)
	if err != nil {
		panic(err)
	}
	if write_length != len(value) {
		panic(fmt.Errorf("bad write length when writing string, expected %d, written %d", len(value), write_length))
	}
}

type FfiDestroyerString struct{}

func (FfiDestroyerString) Destroy(_ string) {}

type FfiConverterBytes struct{}

var FfiConverterBytesINSTANCE = FfiConverterBytes{}

func (c FfiConverterBytes) Lower(value []byte) C.RustBuffer {
	return LowerIntoRustBuffer[[]byte](c, value)
}

func (c FfiConverterBytes) LowerExternal(value []byte) ExternalCRustBuffer {
	return RustBufferFromC(c.Lower(value))
}

func (c FfiConverterBytes) Write(writer io.Writer, value []byte) {
	if len(value) > math.MaxInt32 {
		panic("[]byte is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(value)))
	write_length, err := writer.Write(value)
	if err != nil {
		panic(err)
	}
	if write_length != len(value) {
		panic(fmt.Errorf("bad write length when writing []byte, expected %d, written %d", len(value), write_length))
	}
}

func (c FfiConverterBytes) Lift(rb RustBufferI) []byte {
	return LiftFromRustBuffer[[]byte](c, rb)
}

func (c FfiConverterBytes) Read(reader io.Reader) []byte {
	length := readInt32(reader)
	buffer := make([]byte, length)
	read_length, err := reader.Read(buffer)
	if err != nil && err != io.EOF {
		panic(err)
	}
	if read_length != int(length) {
		panic(fmt.Errorf("bad read length when reading []byte, expected %d, read %d", length, read_length))
	}
	return buffer
}

type FfiDestroyerBytes struct{}

func (FfiDestroyerBytes) Destroy(_ []byte) {}

// Below is an implementation of synchronization requirements outlined in the link.
// https://github.com/mozilla/uniffi-rs/blob/0dc031132d9493ca812c3af6e7dd60ad2ea95bf0/uniffi_bindgen/src/bindings/kotlin/templates/ObjectRuntime.kt#L31

type FfiObject struct {
	handle        C.uint64_t
	callCounter   atomic.Int64
	cloneFunction func(C.uint64_t, *C.RustCallStatus) C.uint64_t
	freeFunction  func(C.uint64_t, *C.RustCallStatus)
	destroyed     atomic.Bool
}

func newFfiObject(
	handle C.uint64_t,
	cloneFunction func(C.uint64_t, *C.RustCallStatus) C.uint64_t,
	freeFunction func(C.uint64_t, *C.RustCallStatus),
) FfiObject {
	return FfiObject{
		handle:        handle,
		cloneFunction: cloneFunction,
		freeFunction:  freeFunction,
	}
}

func (ffiObject *FfiObject) incrementPointer(debugName string) C.uint64_t {
	for {
		counter := ffiObject.callCounter.Load()
		if counter <= -1 {
			panic(fmt.Errorf("%v object has already been destroyed", debugName))
		}
		if counter == math.MaxInt64 {
			panic(fmt.Errorf("%v object call counter would overflow", debugName))
		}
		if ffiObject.callCounter.CompareAndSwap(counter, counter+1) {
			break
		}
	}

	return rustCall(func(status *C.RustCallStatus) C.uint64_t {
		return ffiObject.cloneFunction(ffiObject.handle, status)
	})
}

func (ffiObject *FfiObject) decrementPointer() {
	if ffiObject.callCounter.Add(-1) == -1 {
		ffiObject.freeRustArcPtr()
	}
}

func (ffiObject *FfiObject) destroy() {
	if ffiObject.destroyed.CompareAndSwap(false, true) {
		if ffiObject.callCounter.Add(-1) == -1 {
			ffiObject.freeRustArcPtr()
		}
	}
}

func (ffiObject *FfiObject) freeRustArcPtr() {
	if ffiObject.handle == 0 {
		return
	}
	rustCall(func(status *C.RustCallStatus) int32 {
		ffiObject.freeFunction(ffiObject.handle, status)
		return 0
	})
}

type CommandCoreInterface interface {
	Run(options RunOptions) (ProcessOutput, error)
	Spawn(options SpawnOptions) (*ProcessCore, error)
}
type CommandCore struct {
	ffiObject FfiObject
}

func (_self *CommandCore) Run(options RunOptions) (ProcessOutput, error) {
	_pointer := _self.ffiObject.incrementPointer("*CommandCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) RustBufferI {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_rust_buffer(handle, status)
			return GoRustBuffer{
				inner: res,
			}
		},
		// liftFn
		func(ffi RustBufferI) ProcessOutput {
			return FfiConverterProcessOutputINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_commandcore_run(
			_pointer, FfiConverterRunOptionsINSTANCE.Lower(options)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_rust_buffer(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_rust_buffer(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *CommandCore) Spawn(options SpawnOptions) (*ProcessCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*CommandCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *ProcessCore {
			return FfiConverterProcessCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_commandcore_spawn(
			_pointer, FfiConverterSpawnOptionsINSTANCE.Lower(options)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}
func (object *CommandCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterCommandCore struct{}

var FfiConverterCommandCoreINSTANCE = FfiConverterCommandCore{}

func (c FfiConverterCommandCore) Lift(handle C.uint64_t) *CommandCore {
	result := &CommandCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_commandcore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_commandcore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*CommandCore).Destroy)
	return result
}

func (c FfiConverterCommandCore) Read(reader io.Reader) *CommandCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterCommandCore) Lower(value *CommandCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*CommandCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterCommandCore) Write(writer io.Writer, value *CommandCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalCommandCore(handle uint64) *CommandCore {
	return FfiConverterCommandCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalCommandCore(value *CommandCore) uint64 {
	return uint64(FfiConverterCommandCoreINSTANCE.Lower(value))
}

type FfiDestroyerCommandCore struct{}

func (_ FfiDestroyerCommandCore) Destroy(value *CommandCore) {
	value.Destroy()
}

type CommandRefCoreInterface interface {
	Name() string
}
type CommandRefCore struct {
	ffiObject FfiObject
}

func (_self *CommandRefCore) Name() string {
	_pointer := _self.ffiObject.incrementPointer("*CommandRefCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterStringINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) RustBufferI {
		return GoRustBuffer{
			inner: C.uniffi_wasmer_sdk_uniffi_fn_method_commandrefcore_name(
				_pointer, _uniffiStatus),
		}
	}))
}
func (object *CommandRefCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterCommandRefCore struct{}

var FfiConverterCommandRefCoreINSTANCE = FfiConverterCommandRefCore{}

func (c FfiConverterCommandRefCore) Lift(handle C.uint64_t) *CommandRefCore {
	result := &CommandRefCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_commandrefcore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_commandrefcore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*CommandRefCore).Destroy)
	return result
}

func (c FfiConverterCommandRefCore) Read(reader io.Reader) *CommandRefCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterCommandRefCore) Lower(value *CommandRefCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*CommandRefCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterCommandRefCore) Write(writer io.Writer, value *CommandRefCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalCommandRefCore(handle uint64) *CommandRefCore {
	return FfiConverterCommandRefCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalCommandRefCore(value *CommandRefCore) uint64 {
	return uint64(FfiConverterCommandRefCoreINSTANCE.Lower(value))
}

type FfiDestroyerCommandRefCore struct{}

func (_ FfiDestroyerCommandRefCore) Destroy(value *CommandRefCore) {
	value.Destroy()
}

type FileSystemCoreInterface interface {
	Mkdir(path string, recursive bool) error
	Read(path string) ([]byte, error)
	ReadDir(path string) ([]DirectoryEntry, error)
	Remove(path string, recursive bool) error
	Rename(from string, to string) error
	Stat(path string) (FileStat, error)
	Write(path string, bytes []byte) error
}
type FileSystemCore struct {
	ffiObject FfiObject
}

func (_self *FileSystemCore) Mkdir(path string, recursive bool) error {
	_pointer := _self.ffiObject.incrementPointer("*FileSystemCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_filesystemcore_mkdir(
			_pointer, FfiConverterStringINSTANCE.Lower(path), FfiConverterBoolINSTANCE.Lower(recursive)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}

func (_self *FileSystemCore) Read(path string) ([]byte, error) {
	_pointer := _self.ffiObject.incrementPointer("*FileSystemCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) RustBufferI {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_rust_buffer(handle, status)
			return GoRustBuffer{
				inner: res,
			}
		},
		// liftFn
		func(ffi RustBufferI) []byte {
			return FfiConverterBytesINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_filesystemcore_read(
			_pointer, FfiConverterStringINSTANCE.Lower(path)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_rust_buffer(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_rust_buffer(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *FileSystemCore) ReadDir(path string) ([]DirectoryEntry, error) {
	_pointer := _self.ffiObject.incrementPointer("*FileSystemCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) RustBufferI {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_rust_buffer(handle, status)
			return GoRustBuffer{
				inner: res,
			}
		},
		// liftFn
		func(ffi RustBufferI) []DirectoryEntry {
			return FfiConverterSequenceDirectoryEntryINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_filesystemcore_read_dir(
			_pointer, FfiConverterStringINSTANCE.Lower(path)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_rust_buffer(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_rust_buffer(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *FileSystemCore) Remove(path string, recursive bool) error {
	_pointer := _self.ffiObject.incrementPointer("*FileSystemCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_filesystemcore_remove(
			_pointer, FfiConverterStringINSTANCE.Lower(path), FfiConverterBoolINSTANCE.Lower(recursive)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}

func (_self *FileSystemCore) Rename(from string, to string) error {
	_pointer := _self.ffiObject.incrementPointer("*FileSystemCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_filesystemcore_rename(
			_pointer, FfiConverterStringINSTANCE.Lower(from), FfiConverterStringINSTANCE.Lower(to)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}

func (_self *FileSystemCore) Stat(path string) (FileStat, error) {
	_pointer := _self.ffiObject.incrementPointer("*FileSystemCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) RustBufferI {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_rust_buffer(handle, status)
			return GoRustBuffer{
				inner: res,
			}
		},
		// liftFn
		func(ffi RustBufferI) FileStat {
			return FfiConverterFileStatINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_filesystemcore_stat(
			_pointer, FfiConverterStringINSTANCE.Lower(path)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_rust_buffer(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_rust_buffer(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *FileSystemCore) Write(path string, bytes []byte) error {
	_pointer := _self.ffiObject.incrementPointer("*FileSystemCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_filesystemcore_write(
			_pointer, FfiConverterStringINSTANCE.Lower(path), FfiConverterBytesINSTANCE.Lower(bytes)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}
func (object *FileSystemCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterFileSystemCore struct{}

var FfiConverterFileSystemCoreINSTANCE = FfiConverterFileSystemCore{}

func (c FfiConverterFileSystemCore) Lift(handle C.uint64_t) *FileSystemCore {
	result := &FileSystemCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_filesystemcore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_filesystemcore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*FileSystemCore).Destroy)
	return result
}

func (c FfiConverterFileSystemCore) Read(reader io.Reader) *FileSystemCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterFileSystemCore) Lower(value *FileSystemCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*FileSystemCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterFileSystemCore) Write(writer io.Writer, value *FileSystemCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalFileSystemCore(handle uint64) *FileSystemCore {
	return FfiConverterFileSystemCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalFileSystemCore(value *FileSystemCore) uint64 {
	return uint64(FfiConverterFileSystemCoreINSTANCE.Lower(value))
}

type FfiDestroyerFileSystemCore struct{}

func (_ FfiDestroyerFileSystemCore) Destroy(value *FileSystemCore) {
	value.Destroy()
}

type PackageCoreInterface interface {
	Command(name string) (*CommandRefCore, error)
	Commands() []string
	Entrypoint() *string
	Id() string
}
type PackageCore struct {
	ffiObject FfiObject
}

func (_self *PackageCore) Command(name string) (*CommandRefCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*PackageCore")
	defer _self.ffiObject.decrementPointer()
	_uniffiRV, _uniffiErr := rustCallWithError[*SdkError](FfiConverterSdkError{}, func(_uniffiStatus *C.RustCallStatus) C.uint64_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_packagecore_command(
			_pointer, FfiConverterStringINSTANCE.Lower(name), _uniffiStatus)
	})
	if _uniffiErr != nil {
		var _uniffiDefaultValue *CommandRefCore
		return _uniffiDefaultValue, _uniffiErr
	} else {
		return FfiConverterCommandRefCoreINSTANCE.Lift(_uniffiRV), nil
	}
}

func (_self *PackageCore) Commands() []string {
	_pointer := _self.ffiObject.incrementPointer("*PackageCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterSequenceStringINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) RustBufferI {
		return GoRustBuffer{
			inner: C.uniffi_wasmer_sdk_uniffi_fn_method_packagecore_commands(
				_pointer, _uniffiStatus),
		}
	}))
}

func (_self *PackageCore) Entrypoint() *string {
	_pointer := _self.ffiObject.incrementPointer("*PackageCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterOptionalStringINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) RustBufferI {
		return GoRustBuffer{
			inner: C.uniffi_wasmer_sdk_uniffi_fn_method_packagecore_entrypoint(
				_pointer, _uniffiStatus),
		}
	}))
}

func (_self *PackageCore) Id() string {
	_pointer := _self.ffiObject.incrementPointer("*PackageCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterStringINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) RustBufferI {
		return GoRustBuffer{
			inner: C.uniffi_wasmer_sdk_uniffi_fn_method_packagecore_id(
				_pointer, _uniffiStatus),
		}
	}))
}
func (object *PackageCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterPackageCore struct{}

var FfiConverterPackageCoreINSTANCE = FfiConverterPackageCore{}

func (c FfiConverterPackageCore) Lift(handle C.uint64_t) *PackageCore {
	result := &PackageCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_packagecore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_packagecore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*PackageCore).Destroy)
	return result
}

func (c FfiConverterPackageCore) Read(reader io.Reader) *PackageCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterPackageCore) Lower(value *PackageCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*PackageCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterPackageCore) Write(writer io.Writer, value *PackageCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalPackageCore(handle uint64) *PackageCore {
	return FfiConverterPackageCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalPackageCore(value *PackageCore) uint64 {
	return uint64(FfiConverterPackageCoreINSTANCE.Lower(value))
}

type FfiDestroyerPackageCore struct{}

func (_ FfiDestroyerPackageCore) Destroy(value *PackageCore) {
	value.Destroy()
}

type PortsCoreInterface interface {
	Wait(port uint16, timeoutMs uint64) error
}
type PortsCore struct {
	ffiObject FfiObject
}

func (_self *PortsCore) Wait(port uint16, timeoutMs uint64) error {
	_pointer := _self.ffiObject.incrementPointer("*PortsCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_portscore_wait(
			_pointer, FfiConverterUint16INSTANCE.Lower(port), FfiConverterUint64INSTANCE.Lower(timeoutMs)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}
func (object *PortsCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterPortsCore struct{}

var FfiConverterPortsCoreINSTANCE = FfiConverterPortsCore{}

func (c FfiConverterPortsCore) Lift(handle C.uint64_t) *PortsCore {
	result := &PortsCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_portscore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_portscore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*PortsCore).Destroy)
	return result
}

func (c FfiConverterPortsCore) Read(reader io.Reader) *PortsCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterPortsCore) Lower(value *PortsCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*PortsCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterPortsCore) Write(writer io.Writer, value *PortsCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalPortsCore(handle uint64) *PortsCore {
	return FfiConverterPortsCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalPortsCore(value *PortsCore) uint64 {
	return uint64(FfiConverterPortsCoreINSTANCE.Lower(value))
}

type FfiDestroyerPortsCore struct{}

func (_ FfiDestroyerPortsCore) Destroy(value *PortsCore) {
	value.Destroy()
}

type ProcessCoreInterface interface {
	CloseStdin() error
	HasStderr() bool
	HasStdin() bool
	HasStdout() bool
	Id() uint32
	Kill()
	ReadStderr(maxBytes uint64) (*[]byte, error)
	ReadStdout(maxBytes uint64) (*[]byte, error)
	Terminate(graceMs uint64) error
	Wait() (ProcessOutput, error)
	WriteStdin(bytes []byte) error
}
type ProcessCore struct {
	ffiObject FfiObject
}

func (_self *ProcessCore) CloseStdin() error {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_close_stdin(
			_pointer),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}

func (_self *ProcessCore) HasStderr() bool {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterBoolINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.int8_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_has_stderr(
			_pointer, _uniffiStatus)
	}))
}

func (_self *ProcessCore) HasStdin() bool {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterBoolINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.int8_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_has_stdin(
			_pointer, _uniffiStatus)
	}))
}

func (_self *ProcessCore) HasStdout() bool {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterBoolINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.int8_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_has_stdout(
			_pointer, _uniffiStatus)
	}))
}

func (_self *ProcessCore) Id() uint32 {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterUint32INSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint32_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_id(
			_pointer, _uniffiStatus)
	}))
}

func (_self *ProcessCore) Kill() {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	rustCall(func(_uniffiStatus *C.RustCallStatus) bool {
		C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_kill(
			_pointer, _uniffiStatus)
		return false
	})
}

func (_self *ProcessCore) ReadStderr(maxBytes uint64) (*[]byte, error) {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) RustBufferI {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_rust_buffer(handle, status)
			return GoRustBuffer{
				inner: res,
			}
		},
		// liftFn
		func(ffi RustBufferI) *[]byte {
			return FfiConverterOptionalBytesINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_read_stderr(
			_pointer, FfiConverterUint64INSTANCE.Lower(maxBytes)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_rust_buffer(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_rust_buffer(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *ProcessCore) ReadStdout(maxBytes uint64) (*[]byte, error) {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) RustBufferI {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_rust_buffer(handle, status)
			return GoRustBuffer{
				inner: res,
			}
		},
		// liftFn
		func(ffi RustBufferI) *[]byte {
			return FfiConverterOptionalBytesINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_read_stdout(
			_pointer, FfiConverterUint64INSTANCE.Lower(maxBytes)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_rust_buffer(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_rust_buffer(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *ProcessCore) Terminate(graceMs uint64) error {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_terminate(
			_pointer, FfiConverterUint64INSTANCE.Lower(graceMs)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}

func (_self *ProcessCore) Wait() (ProcessOutput, error) {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) RustBufferI {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_rust_buffer(handle, status)
			return GoRustBuffer{
				inner: res,
			}
		},
		// liftFn
		func(ffi RustBufferI) ProcessOutput {
			return FfiConverterProcessOutputINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_wait(
			_pointer),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_rust_buffer(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_rust_buffer(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *ProcessCore) WriteStdin(bytes []byte) error {
	_pointer := _self.ffiObject.incrementPointer("*ProcessCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_processcore_write_stdin(
			_pointer, FfiConverterBytesINSTANCE.Lower(bytes)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}
func (object *ProcessCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterProcessCore struct{}

var FfiConverterProcessCoreINSTANCE = FfiConverterProcessCore{}

func (c FfiConverterProcessCore) Lift(handle C.uint64_t) *ProcessCore {
	result := &ProcessCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_processcore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_processcore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*ProcessCore).Destroy)
	return result
}

func (c FfiConverterProcessCore) Read(reader io.Reader) *ProcessCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterProcessCore) Lower(value *ProcessCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*ProcessCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterProcessCore) Write(writer io.Writer, value *ProcessCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalProcessCore(handle uint64) *ProcessCore {
	return FfiConverterProcessCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalProcessCore(value *ProcessCore) uint64 {
	return uint64(FfiConverterProcessCoreINSTANCE.Lower(value))
}

type FfiDestroyerProcessCore struct{}

func (_ FfiDestroyerProcessCore) Destroy(value *ProcessCore) {
	value.Destroy()
}

type SandboxCoreInterface interface {
	Close() error
	CommandName(name string, args []string, cwd *string, env map[string]string) *CommandCore
	CommandPackage(varPackage *PackageCore, args []string, cwd *string, env map[string]string) *CommandCore
	CommandRef(reference *CommandRefCore, args []string, cwd *string, env map[string]string) *CommandCore
	Filesystem() *FileSystemCore
	InstallPackageBytes(bytes []byte) (*PackageCore, error)
	InstallPackagePath(path string) (*PackageCore, error)
	InstallPackageRef(varPackage *PackageCore) (*PackageCore, error)
	InstallPackageRegistry(specifier string) (*PackageCore, error)
	Ports() *PortsCore
}
type SandboxCore struct {
	ffiObject FfiObject
}

func (_self *SandboxCore) Close() error {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_close(
			_pointer),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}

func (_self *SandboxCore) CommandName(name string, args []string, cwd *string, env map[string]string) *CommandCore {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterCommandCoreINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint64_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_command_name(
			_pointer, FfiConverterStringINSTANCE.Lower(name), FfiConverterSequenceStringINSTANCE.Lower(args), FfiConverterOptionalStringINSTANCE.Lower(cwd), FfiConverterMapStringStringINSTANCE.Lower(env), _uniffiStatus)
	}))
}

func (_self *SandboxCore) CommandPackage(varPackage *PackageCore, args []string, cwd *string, env map[string]string) *CommandCore {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterCommandCoreINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint64_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_command_package(
			_pointer, FfiConverterPackageCoreINSTANCE.Lower(varPackage), FfiConverterSequenceStringINSTANCE.Lower(args), FfiConverterOptionalStringINSTANCE.Lower(cwd), FfiConverterMapStringStringINSTANCE.Lower(env), _uniffiStatus)
	}))
}

func (_self *SandboxCore) CommandRef(reference *CommandRefCore, args []string, cwd *string, env map[string]string) *CommandCore {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterCommandCoreINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint64_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_command_ref(
			_pointer, FfiConverterCommandRefCoreINSTANCE.Lower(reference), FfiConverterSequenceStringINSTANCE.Lower(args), FfiConverterOptionalStringINSTANCE.Lower(cwd), FfiConverterMapStringStringINSTANCE.Lower(env), _uniffiStatus)
	}))
}

func (_self *SandboxCore) Filesystem() *FileSystemCore {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterFileSystemCoreINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint64_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_filesystem(
			_pointer, _uniffiStatus)
	}))
}

func (_self *SandboxCore) InstallPackageBytes(bytes []byte) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_install_package_bytes(
			_pointer, FfiConverterBytesINSTANCE.Lower(bytes)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *SandboxCore) InstallPackagePath(path string) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_install_package_path(
			_pointer, FfiConverterStringINSTANCE.Lower(path)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *SandboxCore) InstallPackageRef(varPackage *PackageCore) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_install_package_ref(
			_pointer, FfiConverterPackageCoreINSTANCE.Lower(varPackage)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *SandboxCore) InstallPackageRegistry(specifier string) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_install_package_registry(
			_pointer, FfiConverterStringINSTANCE.Lower(specifier)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *SandboxCore) Ports() *PortsCore {
	_pointer := _self.ffiObject.incrementPointer("*SandboxCore")
	defer _self.ffiObject.decrementPointer()
	return FfiConverterPortsCoreINSTANCE.Lift(rustCall(func(_uniffiStatus *C.RustCallStatus) C.uint64_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_method_sandboxcore_ports(
			_pointer, _uniffiStatus)
	}))
}
func (object *SandboxCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterSandboxCore struct{}

var FfiConverterSandboxCoreINSTANCE = FfiConverterSandboxCore{}

func (c FfiConverterSandboxCore) Lift(handle C.uint64_t) *SandboxCore {
	result := &SandboxCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_sandboxcore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_sandboxcore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*SandboxCore).Destroy)
	return result
}

func (c FfiConverterSandboxCore) Read(reader io.Reader) *SandboxCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterSandboxCore) Lower(value *SandboxCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*SandboxCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterSandboxCore) Write(writer io.Writer, value *SandboxCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalSandboxCore(handle uint64) *SandboxCore {
	return FfiConverterSandboxCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalSandboxCore(value *SandboxCore) uint64 {
	return uint64(FfiConverterSandboxCoreINSTANCE.Lower(value))
}

type FfiDestroyerSandboxCore struct{}

func (_ FfiDestroyerSandboxCore) Destroy(value *SandboxCore) {
	value.Destroy()
}

type WasmerCoreInterface interface {
	Close() error
	CreatePackage(definition PackageDefinition) (*PackageCore, error)
	CreateSandbox(packages []*PackageCore, files map[string][]byte, env map[string]string, network NetworkMode) (*SandboxCore, error)
	LoadPackageBytes(bytes []byte) (*PackageCore, error)
	LoadPackagePath(path string) (*PackageCore, error)
	LoadPackageRegistry(specifier string) (*PackageCore, error)
}
type WasmerCore struct {
	ffiObject FfiObject
}

func NewWasmerCore(options ClientOptions) (*WasmerCore, error) {
	_uniffiRV, _uniffiErr := rustCallWithError[*SdkError](FfiConverterSdkError{}, func(_uniffiStatus *C.RustCallStatus) C.uint64_t {
		return C.uniffi_wasmer_sdk_uniffi_fn_constructor_wasmercore_new(FfiConverterClientOptionsINSTANCE.Lower(options), _uniffiStatus)
	})
	if _uniffiErr != nil {
		var _uniffiDefaultValue *WasmerCore
		return _uniffiDefaultValue, _uniffiErr
	} else {
		return FfiConverterWasmerCoreINSTANCE.Lift(_uniffiRV), nil
	}
}

func (_self *WasmerCore) Close() error {
	_pointer := _self.ffiObject.incrementPointer("*WasmerCore")
	defer _self.ffiObject.decrementPointer()
	_, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) struct{} {
			C.ffi_wasmer_sdk_uniffi_rust_future_complete_void(handle, status)
			return struct{}{}
		},
		// liftFn
		func(_ struct{}) struct{} { return struct{}{} },
		C.uniffi_wasmer_sdk_uniffi_fn_method_wasmercore_close(
			_pointer),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_void(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_void(handle)
		},
	)

	if err == nil {
		return nil
	}

	return err
}

func (_self *WasmerCore) CreatePackage(definition PackageDefinition) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*WasmerCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_wasmercore_create_package(
			_pointer, FfiConverterPackageDefinitionINSTANCE.Lower(definition)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *WasmerCore) CreateSandbox(packages []*PackageCore, files map[string][]byte, env map[string]string, network NetworkMode) (*SandboxCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*WasmerCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *SandboxCore {
			return FfiConverterSandboxCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_wasmercore_create_sandbox(
			_pointer, FfiConverterSequencePackageCoreINSTANCE.Lower(packages), FfiConverterMapStringBytesINSTANCE.Lower(files), FfiConverterMapStringStringINSTANCE.Lower(env), FfiConverterNetworkModeINSTANCE.Lower(network)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *WasmerCore) LoadPackageBytes(bytes []byte) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*WasmerCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_wasmercore_load_package_bytes(
			_pointer, FfiConverterBytesINSTANCE.Lower(bytes)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *WasmerCore) LoadPackagePath(path string) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*WasmerCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_wasmercore_load_package_path(
			_pointer, FfiConverterStringINSTANCE.Lower(path)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}

func (_self *WasmerCore) LoadPackageRegistry(specifier string) (*PackageCore, error) {
	_pointer := _self.ffiObject.incrementPointer("*WasmerCore")
	defer _self.ffiObject.decrementPointer()
	res, err := uniffiRustCallAsync[*SdkError](
		FfiConverterSdkErrorINSTANCE,
		// completeFn
		func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
			res := C.ffi_wasmer_sdk_uniffi_rust_future_complete_u64(handle, status)
			return res
		},
		// liftFn
		func(ffi C.uint64_t) *PackageCore {
			return FfiConverterPackageCoreINSTANCE.Lift(ffi)
		},
		C.uniffi_wasmer_sdk_uniffi_fn_method_wasmercore_load_package_registry(
			_pointer, FfiConverterStringINSTANCE.Lower(specifier)),
		// pollFn
		func(handle C.uint64_t, continuation C.UniffiRustFutureContinuationCallback, data C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_poll_u64(handle, continuation, data)
		},
		// freeFn
		func(handle C.uint64_t) {
			C.ffi_wasmer_sdk_uniffi_rust_future_free_u64(handle)
		},
	)

	if err == nil {
		return res, nil
	}

	return res, err
}
func (object *WasmerCore) Destroy() {
	runtime.SetFinalizer(object, nil)
	object.ffiObject.destroy()
}

type FfiConverterWasmerCore struct{}

var FfiConverterWasmerCoreINSTANCE = FfiConverterWasmerCore{}

func (c FfiConverterWasmerCore) Lift(handle C.uint64_t) *WasmerCore {
	result := &WasmerCore{
		newFfiObject(
			handle,
			func(handle C.uint64_t, status *C.RustCallStatus) C.uint64_t {
				return C.uniffi_wasmer_sdk_uniffi_fn_clone_wasmercore(handle, status)
			},
			func(handle C.uint64_t, status *C.RustCallStatus) {
				C.uniffi_wasmer_sdk_uniffi_fn_free_wasmercore(handle, status)
			},
		),
	}
	runtime.SetFinalizer(result, (*WasmerCore).Destroy)
	return result
}

func (c FfiConverterWasmerCore) Read(reader io.Reader) *WasmerCore {
	return c.Lift(C.uint64_t(readUint64(reader)))
}

func (c FfiConverterWasmerCore) Lower(value *WasmerCore) C.uint64_t {
	// TODO: this is bad - all synchronization from ObjectRuntime.go is discarded here,
	// because the handle will be decremented immediately after this function returns,
	// and someone will be left holding onto a non-locked handle.
	handle := value.ffiObject.incrementPointer("*WasmerCore")
	defer value.ffiObject.decrementPointer()
	return handle
}

func (c FfiConverterWasmerCore) Write(writer io.Writer, value *WasmerCore) {
	writeUint64(writer, uint64(c.Lower(value)))
}

func LiftFromExternalWasmerCore(handle uint64) *WasmerCore {
	return FfiConverterWasmerCoreINSTANCE.Lift(C.uint64_t(handle))
}

func LowerToExternalWasmerCore(value *WasmerCore) uint64 {
	return uint64(FfiConverterWasmerCoreINSTANCE.Lower(value))
}

type FfiDestroyerWasmerCore struct{}

func (_ FfiDestroyerWasmerCore) Destroy(value *WasmerCore) {
	value.Destroy()
}

type ClientOptions struct {
	CacheRoot   *string
	OutputBytes *uint64
}

func (r *ClientOptions) Destroy() {
	FfiDestroyerOptionalString{}.Destroy(r.CacheRoot)
	FfiDestroyerOptionalUint64{}.Destroy(r.OutputBytes)
}

type FfiConverterClientOptions struct{}

var FfiConverterClientOptionsINSTANCE = FfiConverterClientOptions{}

func (c FfiConverterClientOptions) Lift(rb RustBufferI) ClientOptions {
	return LiftFromRustBuffer[ClientOptions](c, rb)
}

func (c FfiConverterClientOptions) Read(reader io.Reader) ClientOptions {
	return ClientOptions{
		FfiConverterOptionalStringINSTANCE.Read(reader),
		FfiConverterOptionalUint64INSTANCE.Read(reader),
	}
}

func (c FfiConverterClientOptions) Lower(value ClientOptions) C.RustBuffer {
	return LowerIntoRustBuffer[ClientOptions](c, value)
}

func (c FfiConverterClientOptions) LowerExternal(value ClientOptions) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[ClientOptions](c, value))
}

func (c FfiConverterClientOptions) Write(writer io.Writer, value ClientOptions) {
	FfiConverterOptionalStringINSTANCE.Write(writer, value.CacheRoot)
	FfiConverterOptionalUint64INSTANCE.Write(writer, value.OutputBytes)
}

type FfiDestroyerClientOptions struct{}

func (_ FfiDestroyerClientOptions) Destroy(value ClientOptions) {
	value.Destroy()
}

type DirectoryEntry struct {
	Name string
	Kind FileKind
	Size uint64
}

func (r *DirectoryEntry) Destroy() {
	FfiDestroyerString{}.Destroy(r.Name)
	FfiDestroyerFileKind{}.Destroy(r.Kind)
	FfiDestroyerUint64{}.Destroy(r.Size)
}

type FfiConverterDirectoryEntry struct{}

var FfiConverterDirectoryEntryINSTANCE = FfiConverterDirectoryEntry{}

func (c FfiConverterDirectoryEntry) Lift(rb RustBufferI) DirectoryEntry {
	return LiftFromRustBuffer[DirectoryEntry](c, rb)
}

func (c FfiConverterDirectoryEntry) Read(reader io.Reader) DirectoryEntry {
	return DirectoryEntry{
		FfiConverterStringINSTANCE.Read(reader),
		FfiConverterFileKindINSTANCE.Read(reader),
		FfiConverterUint64INSTANCE.Read(reader),
	}
}

func (c FfiConverterDirectoryEntry) Lower(value DirectoryEntry) C.RustBuffer {
	return LowerIntoRustBuffer[DirectoryEntry](c, value)
}

func (c FfiConverterDirectoryEntry) LowerExternal(value DirectoryEntry) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[DirectoryEntry](c, value))
}

func (c FfiConverterDirectoryEntry) Write(writer io.Writer, value DirectoryEntry) {
	FfiConverterStringINSTANCE.Write(writer, value.Name)
	FfiConverterFileKindINSTANCE.Write(writer, value.Kind)
	FfiConverterUint64INSTANCE.Write(writer, value.Size)
}

type FfiDestroyerDirectoryEntry struct{}

func (_ FfiDestroyerDirectoryEntry) Destroy(value DirectoryEntry) {
	value.Destroy()
}

type FileStat struct {
	Kind FileKind
	Size uint64
}

func (r *FileStat) Destroy() {
	FfiDestroyerFileKind{}.Destroy(r.Kind)
	FfiDestroyerUint64{}.Destroy(r.Size)
}

type FfiConverterFileStat struct{}

var FfiConverterFileStatINSTANCE = FfiConverterFileStat{}

func (c FfiConverterFileStat) Lift(rb RustBufferI) FileStat {
	return LiftFromRustBuffer[FileStat](c, rb)
}

func (c FfiConverterFileStat) Read(reader io.Reader) FileStat {
	return FileStat{
		FfiConverterFileKindINSTANCE.Read(reader),
		FfiConverterUint64INSTANCE.Read(reader),
	}
}

func (c FfiConverterFileStat) Lower(value FileStat) C.RustBuffer {
	return LowerIntoRustBuffer[FileStat](c, value)
}

func (c FfiConverterFileStat) LowerExternal(value FileStat) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[FileStat](c, value))
}

func (c FfiConverterFileStat) Write(writer io.Writer, value FileStat) {
	FfiConverterFileKindINSTANCE.Write(writer, value.Kind)
	FfiConverterUint64INSTANCE.Write(writer, value.Size)
}

type FfiDestroyerFileStat struct{}

func (_ FfiDestroyerFileStat) Destroy(value FileStat) {
	value.Destroy()
}

type PackageCommandDefinition struct {
	Module string
}

func (r *PackageCommandDefinition) Destroy() {
	FfiDestroyerString{}.Destroy(r.Module)
}

type FfiConverterPackageCommandDefinition struct{}

var FfiConverterPackageCommandDefinitionINSTANCE = FfiConverterPackageCommandDefinition{}

func (c FfiConverterPackageCommandDefinition) Lift(rb RustBufferI) PackageCommandDefinition {
	return LiftFromRustBuffer[PackageCommandDefinition](c, rb)
}

func (c FfiConverterPackageCommandDefinition) Read(reader io.Reader) PackageCommandDefinition {
	return PackageCommandDefinition{
		FfiConverterStringINSTANCE.Read(reader),
	}
}

func (c FfiConverterPackageCommandDefinition) Lower(value PackageCommandDefinition) C.RustBuffer {
	return LowerIntoRustBuffer[PackageCommandDefinition](c, value)
}

func (c FfiConverterPackageCommandDefinition) LowerExternal(value PackageCommandDefinition) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[PackageCommandDefinition](c, value))
}

func (c FfiConverterPackageCommandDefinition) Write(writer io.Writer, value PackageCommandDefinition) {
	FfiConverterStringINSTANCE.Write(writer, value.Module)
}

type FfiDestroyerPackageCommandDefinition struct{}

func (_ FfiDestroyerPackageCommandDefinition) Destroy(value PackageCommandDefinition) {
	value.Destroy()
}

// An in-memory package definition shared with the SDK core.
type PackageDefinition struct {
	Modules    map[string][]byte
	Commands   map[string]PackageCommandDefinition
	Entrypoint *string
	Files      map[string][]byte
}

func (r *PackageDefinition) Destroy() {
	FfiDestroyerMapStringBytes{}.Destroy(r.Modules)
	FfiDestroyerMapStringPackageCommandDefinition{}.Destroy(r.Commands)
	FfiDestroyerOptionalString{}.Destroy(r.Entrypoint)
	FfiDestroyerMapStringBytes{}.Destroy(r.Files)
}

type FfiConverterPackageDefinition struct{}

var FfiConverterPackageDefinitionINSTANCE = FfiConverterPackageDefinition{}

func (c FfiConverterPackageDefinition) Lift(rb RustBufferI) PackageDefinition {
	return LiftFromRustBuffer[PackageDefinition](c, rb)
}

func (c FfiConverterPackageDefinition) Read(reader io.Reader) PackageDefinition {
	return PackageDefinition{
		FfiConverterMapStringBytesINSTANCE.Read(reader),
		FfiConverterMapStringPackageCommandDefinitionINSTANCE.Read(reader),
		FfiConverterOptionalStringINSTANCE.Read(reader),
		FfiConverterMapStringBytesINSTANCE.Read(reader),
	}
}

func (c FfiConverterPackageDefinition) Lower(value PackageDefinition) C.RustBuffer {
	return LowerIntoRustBuffer[PackageDefinition](c, value)
}

func (c FfiConverterPackageDefinition) LowerExternal(value PackageDefinition) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[PackageDefinition](c, value))
}

func (c FfiConverterPackageDefinition) Write(writer io.Writer, value PackageDefinition) {
	FfiConverterMapStringBytesINSTANCE.Write(writer, value.Modules)
	FfiConverterMapStringPackageCommandDefinitionINSTANCE.Write(writer, value.Commands)
	FfiConverterOptionalStringINSTANCE.Write(writer, value.Entrypoint)
	FfiConverterMapStringBytesINSTANCE.Write(writer, value.Files)
}

type FfiDestroyerPackageDefinition struct{}

func (_ FfiDestroyerPackageDefinition) Destroy(value PackageDefinition) {
	value.Destroy()
}

type ProcessOutput struct {
	ExitCode        int32
	Reason          ProcessExitReason
	Stdout          []byte
	Stderr          []byte
	StdoutTruncated bool
	StderrTruncated bool
}

func (r *ProcessOutput) Destroy() {
	FfiDestroyerInt32{}.Destroy(r.ExitCode)
	FfiDestroyerProcessExitReason{}.Destroy(r.Reason)
	FfiDestroyerBytes{}.Destroy(r.Stdout)
	FfiDestroyerBytes{}.Destroy(r.Stderr)
	FfiDestroyerBool{}.Destroy(r.StdoutTruncated)
	FfiDestroyerBool{}.Destroy(r.StderrTruncated)
}

type FfiConverterProcessOutput struct{}

var FfiConverterProcessOutputINSTANCE = FfiConverterProcessOutput{}

func (c FfiConverterProcessOutput) Lift(rb RustBufferI) ProcessOutput {
	return LiftFromRustBuffer[ProcessOutput](c, rb)
}

func (c FfiConverterProcessOutput) Read(reader io.Reader) ProcessOutput {
	return ProcessOutput{
		FfiConverterInt32INSTANCE.Read(reader),
		FfiConverterProcessExitReasonINSTANCE.Read(reader),
		FfiConverterBytesINSTANCE.Read(reader),
		FfiConverterBytesINSTANCE.Read(reader),
		FfiConverterBoolINSTANCE.Read(reader),
		FfiConverterBoolINSTANCE.Read(reader),
	}
}

func (c FfiConverterProcessOutput) Lower(value ProcessOutput) C.RustBuffer {
	return LowerIntoRustBuffer[ProcessOutput](c, value)
}

func (c FfiConverterProcessOutput) LowerExternal(value ProcessOutput) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[ProcessOutput](c, value))
}

func (c FfiConverterProcessOutput) Write(writer io.Writer, value ProcessOutput) {
	FfiConverterInt32INSTANCE.Write(writer, value.ExitCode)
	FfiConverterProcessExitReasonINSTANCE.Write(writer, value.Reason)
	FfiConverterBytesINSTANCE.Write(writer, value.Stdout)
	FfiConverterBytesINSTANCE.Write(writer, value.Stderr)
	FfiConverterBoolINSTANCE.Write(writer, value.StdoutTruncated)
	FfiConverterBoolINSTANCE.Write(writer, value.StderrTruncated)
}

type FfiDestroyerProcessOutput struct{}

func (_ FfiDestroyerProcessOutput) Destroy(value ProcessOutput) {
	value.Destroy()
}

type RunOptions struct {
	Input       *[]byte
	TimeoutMs   *uint64
	OutputBytes *uint64
}

func (r *RunOptions) Destroy() {
	FfiDestroyerOptionalBytes{}.Destroy(r.Input)
	FfiDestroyerOptionalUint64{}.Destroy(r.TimeoutMs)
	FfiDestroyerOptionalUint64{}.Destroy(r.OutputBytes)
}

type FfiConverterRunOptions struct{}

var FfiConverterRunOptionsINSTANCE = FfiConverterRunOptions{}

func (c FfiConverterRunOptions) Lift(rb RustBufferI) RunOptions {
	return LiftFromRustBuffer[RunOptions](c, rb)
}

func (c FfiConverterRunOptions) Read(reader io.Reader) RunOptions {
	return RunOptions{
		FfiConverterOptionalBytesINSTANCE.Read(reader),
		FfiConverterOptionalUint64INSTANCE.Read(reader),
		FfiConverterOptionalUint64INSTANCE.Read(reader),
	}
}

func (c FfiConverterRunOptions) Lower(value RunOptions) C.RustBuffer {
	return LowerIntoRustBuffer[RunOptions](c, value)
}

func (c FfiConverterRunOptions) LowerExternal(value RunOptions) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[RunOptions](c, value))
}

func (c FfiConverterRunOptions) Write(writer io.Writer, value RunOptions) {
	FfiConverterOptionalBytesINSTANCE.Write(writer, value.Input)
	FfiConverterOptionalUint64INSTANCE.Write(writer, value.TimeoutMs)
	FfiConverterOptionalUint64INSTANCE.Write(writer, value.OutputBytes)
}

type FfiDestroyerRunOptions struct{}

func (_ FfiDestroyerRunOptions) Destroy(value RunOptions) {
	value.Destroy()
}

type SpawnOptions struct {
	TimeoutMs   *uint64
	OutputBytes *uint64
	Stdin       InputMode
	Stdout      OutputMode
	Stderr      OutputMode
}

func (r *SpawnOptions) Destroy() {
	FfiDestroyerOptionalUint64{}.Destroy(r.TimeoutMs)
	FfiDestroyerOptionalUint64{}.Destroy(r.OutputBytes)
	FfiDestroyerInputMode{}.Destroy(r.Stdin)
	FfiDestroyerOutputMode{}.Destroy(r.Stdout)
	FfiDestroyerOutputMode{}.Destroy(r.Stderr)
}

type FfiConverterSpawnOptions struct{}

var FfiConverterSpawnOptionsINSTANCE = FfiConverterSpawnOptions{}

func (c FfiConverterSpawnOptions) Lift(rb RustBufferI) SpawnOptions {
	return LiftFromRustBuffer[SpawnOptions](c, rb)
}

func (c FfiConverterSpawnOptions) Read(reader io.Reader) SpawnOptions {
	return SpawnOptions{
		FfiConverterOptionalUint64INSTANCE.Read(reader),
		FfiConverterOptionalUint64INSTANCE.Read(reader),
		FfiConverterInputModeINSTANCE.Read(reader),
		FfiConverterOutputModeINSTANCE.Read(reader),
		FfiConverterOutputModeINSTANCE.Read(reader),
	}
}

func (c FfiConverterSpawnOptions) Lower(value SpawnOptions) C.RustBuffer {
	return LowerIntoRustBuffer[SpawnOptions](c, value)
}

func (c FfiConverterSpawnOptions) LowerExternal(value SpawnOptions) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[SpawnOptions](c, value))
}

func (c FfiConverterSpawnOptions) Write(writer io.Writer, value SpawnOptions) {
	FfiConverterOptionalUint64INSTANCE.Write(writer, value.TimeoutMs)
	FfiConverterOptionalUint64INSTANCE.Write(writer, value.OutputBytes)
	FfiConverterInputModeINSTANCE.Write(writer, value.Stdin)
	FfiConverterOutputModeINSTANCE.Write(writer, value.Stdout)
	FfiConverterOutputModeINSTANCE.Write(writer, value.Stderr)
}

type FfiDestroyerSpawnOptions struct{}

func (_ FfiDestroyerSpawnOptions) Destroy(value SpawnOptions) {
	value.Destroy()
}

type FileKind uint

const (
	FileKindFile      FileKind = 1
	FileKindDirectory FileKind = 2
)

type FfiConverterFileKind struct{}

var FfiConverterFileKindINSTANCE = FfiConverterFileKind{}

func (c FfiConverterFileKind) Lift(rb RustBufferI) FileKind {
	return LiftFromRustBuffer[FileKind](c, rb)
}

func (c FfiConverterFileKind) Lower(value FileKind) C.RustBuffer {
	return LowerIntoRustBuffer[FileKind](c, value)
}

func (c FfiConverterFileKind) LowerExternal(value FileKind) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[FileKind](c, value))
}
func (FfiConverterFileKind) Read(reader io.Reader) FileKind {
	id := readInt32(reader)
	return FileKind(id)
}

func (FfiConverterFileKind) Write(writer io.Writer, value FileKind) {
	writeInt32(writer, int32(value))
}

type FfiDestroyerFileKind struct{}

func (_ FfiDestroyerFileKind) Destroy(value FileKind) {
}

type InputMode uint

const (
	InputModeClosed InputMode = 1
	InputModePipe   InputMode = 2
)

type FfiConverterInputMode struct{}

var FfiConverterInputModeINSTANCE = FfiConverterInputMode{}

func (c FfiConverterInputMode) Lift(rb RustBufferI) InputMode {
	return LiftFromRustBuffer[InputMode](c, rb)
}

func (c FfiConverterInputMode) Lower(value InputMode) C.RustBuffer {
	return LowerIntoRustBuffer[InputMode](c, value)
}

func (c FfiConverterInputMode) LowerExternal(value InputMode) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[InputMode](c, value))
}
func (FfiConverterInputMode) Read(reader io.Reader) InputMode {
	id := readInt32(reader)
	return InputMode(id)
}

func (FfiConverterInputMode) Write(writer io.Writer, value InputMode) {
	writeInt32(writer, int32(value))
}

type FfiDestroyerInputMode struct{}

func (_ FfiDestroyerInputMode) Destroy(value InputMode) {
}

type NetworkMode uint

const (
	NetworkModeDisabled NetworkMode = 1
	NetworkModeHost     NetworkMode = 2
)

type FfiConverterNetworkMode struct{}

var FfiConverterNetworkModeINSTANCE = FfiConverterNetworkMode{}

func (c FfiConverterNetworkMode) Lift(rb RustBufferI) NetworkMode {
	return LiftFromRustBuffer[NetworkMode](c, rb)
}

func (c FfiConverterNetworkMode) Lower(value NetworkMode) C.RustBuffer {
	return LowerIntoRustBuffer[NetworkMode](c, value)
}

func (c FfiConverterNetworkMode) LowerExternal(value NetworkMode) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[NetworkMode](c, value))
}
func (FfiConverterNetworkMode) Read(reader io.Reader) NetworkMode {
	id := readInt32(reader)
	return NetworkMode(id)
}

func (FfiConverterNetworkMode) Write(writer io.Writer, value NetworkMode) {
	writeInt32(writer, int32(value))
}

type FfiDestroyerNetworkMode struct{}

func (_ FfiDestroyerNetworkMode) Destroy(value NetworkMode) {
}

type OutputMode uint

const (
	OutputModePipe    OutputMode = 1
	OutputModeCapture OutputMode = 2
	OutputModeDiscard OutputMode = 3
)

type FfiConverterOutputMode struct{}

var FfiConverterOutputModeINSTANCE = FfiConverterOutputMode{}

func (c FfiConverterOutputMode) Lift(rb RustBufferI) OutputMode {
	return LiftFromRustBuffer[OutputMode](c, rb)
}

func (c FfiConverterOutputMode) Lower(value OutputMode) C.RustBuffer {
	return LowerIntoRustBuffer[OutputMode](c, value)
}

func (c FfiConverterOutputMode) LowerExternal(value OutputMode) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[OutputMode](c, value))
}
func (FfiConverterOutputMode) Read(reader io.Reader) OutputMode {
	id := readInt32(reader)
	return OutputMode(id)
}

func (FfiConverterOutputMode) Write(writer io.Writer, value OutputMode) {
	writeInt32(writer, int32(value))
}

type FfiDestroyerOutputMode struct{}

func (_ FfiDestroyerOutputMode) Destroy(value OutputMode) {
}

type ProcessExitReason uint

const (
	ProcessExitReasonExited     ProcessExitReason = 1
	ProcessExitReasonTerminated ProcessExitReason = 2
	ProcessExitReasonTimeout    ProcessExitReason = 3
	ProcessExitReasonUnknown    ProcessExitReason = 4
)

type FfiConverterProcessExitReason struct{}

var FfiConverterProcessExitReasonINSTANCE = FfiConverterProcessExitReason{}

func (c FfiConverterProcessExitReason) Lift(rb RustBufferI) ProcessExitReason {
	return LiftFromRustBuffer[ProcessExitReason](c, rb)
}

func (c FfiConverterProcessExitReason) Lower(value ProcessExitReason) C.RustBuffer {
	return LowerIntoRustBuffer[ProcessExitReason](c, value)
}

func (c FfiConverterProcessExitReason) LowerExternal(value ProcessExitReason) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[ProcessExitReason](c, value))
}
func (FfiConverterProcessExitReason) Read(reader io.Reader) ProcessExitReason {
	id := readInt32(reader)
	return ProcessExitReason(id)
}

func (FfiConverterProcessExitReason) Write(writer io.Writer, value ProcessExitReason) {
	writeInt32(writer, int32(value))
}

type FfiDestroyerProcessExitReason struct{}

func (_ FfiDestroyerProcessExitReason) Destroy(value ProcessExitReason) {
}

type SdkError struct {
	err error
}

// Convenience method to turn *SdkError into error
// Avoiding treating nil pointer as non nil error interface
func (err *SdkError) AsError() error {
	if err == nil {
		return nil
	} else {
		return err
	}
}

func (err SdkError) Error() string {
	return fmt.Sprintf("SdkError: %s", err.err.Error())
}

func (err SdkError) Unwrap() error {
	return err.err
}

// Err* are used for checking error type with `errors.Is`
var ErrSdkErrorFailure = fmt.Errorf("SdkErrorFailure")

// Variant structs
type SdkErrorFailure struct {
	Code    string
	Message string
}

func NewSdkErrorFailure(
	code string,
	message string,
) *SdkError {
	return &SdkError{err: &SdkErrorFailure{
		Code:    code,
		Message: message}}
}

func (e SdkErrorFailure) destroy() {
	FfiDestroyerString{}.Destroy(e.Code)
	FfiDestroyerString{}.Destroy(e.Message)
}

func (err SdkErrorFailure) Error() string {
	return fmt.Sprint("Failure",
		": ",

		"Code=",
		err.Code,
		", ",
		"Message=",
		err.Message,
	)
}

func (self SdkErrorFailure) Is(target error) bool {
	return target == ErrSdkErrorFailure
}

type FfiConverterSdkError struct{}

var FfiConverterSdkErrorINSTANCE = FfiConverterSdkError{}

func (c FfiConverterSdkError) Lift(eb RustBufferI) *SdkError {
	return LiftFromRustBuffer[*SdkError](c, eb)
}

func (c FfiConverterSdkError) Lower(value *SdkError) C.RustBuffer {
	return LowerIntoRustBuffer[*SdkError](c, value)
}

func (c FfiConverterSdkError) LowerExternal(value *SdkError) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[*SdkError](c, value))
}

func (c FfiConverterSdkError) Read(reader io.Reader) *SdkError {
	errorID := readUint32(reader)

	switch errorID {
	case 1:
		return &SdkError{&SdkErrorFailure{
			Code:    FfiConverterStringINSTANCE.Read(reader),
			Message: FfiConverterStringINSTANCE.Read(reader),
		}}
	default:
		panic(fmt.Sprintf("Unknown error code %d in FfiConverterSdkError.Read()", errorID))
	}
}

func (c FfiConverterSdkError) Write(writer io.Writer, value *SdkError) {
	switch variantValue := value.err.(type) {
	case *SdkErrorFailure:
		writeInt32(writer, 1)
		FfiConverterStringINSTANCE.Write(writer, variantValue.Code)
		FfiConverterStringINSTANCE.Write(writer, variantValue.Message)
	default:
		_ = variantValue
		panic(fmt.Sprintf("invalid error value `%v` in FfiConverterSdkError.Write", value))
	}
}

type FfiDestroyerSdkError struct{}

func (_ FfiDestroyerSdkError) Destroy(value *SdkError) {
	switch variantValue := value.err.(type) {
	case SdkErrorFailure:
		variantValue.destroy()
	default:
		_ = variantValue
		panic(fmt.Sprintf("invalid error value `%v` in FfiDestroyerSdkError.Destroy", value))
	}
}

type FfiConverterOptionalUint64 struct{}

var FfiConverterOptionalUint64INSTANCE = FfiConverterOptionalUint64{}

func (c FfiConverterOptionalUint64) Lift(rb RustBufferI) *uint64 {
	return LiftFromRustBuffer[*uint64](c, rb)
}

func (_ FfiConverterOptionalUint64) Read(reader io.Reader) *uint64 {
	if readInt8(reader) == 0 {
		return nil
	}
	temp := FfiConverterUint64INSTANCE.Read(reader)
	return &temp
}

func (c FfiConverterOptionalUint64) Lower(value *uint64) C.RustBuffer {
	return LowerIntoRustBuffer[*uint64](c, value)
}

func (c FfiConverterOptionalUint64) LowerExternal(value *uint64) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[*uint64](c, value))
}

func (_ FfiConverterOptionalUint64) Write(writer io.Writer, value *uint64) {
	if value == nil {
		writeInt8(writer, 0)
	} else {
		writeInt8(writer, 1)
		FfiConverterUint64INSTANCE.Write(writer, *value)
	}
}

type FfiDestroyerOptionalUint64 struct{}

func (_ FfiDestroyerOptionalUint64) Destroy(value *uint64) {
	if value != nil {
		FfiDestroyerUint64{}.Destroy(*value)
	}
}

type FfiConverterOptionalString struct{}

var FfiConverterOptionalStringINSTANCE = FfiConverterOptionalString{}

func (c FfiConverterOptionalString) Lift(rb RustBufferI) *string {
	return LiftFromRustBuffer[*string](c, rb)
}

func (_ FfiConverterOptionalString) Read(reader io.Reader) *string {
	if readInt8(reader) == 0 {
		return nil
	}
	temp := FfiConverterStringINSTANCE.Read(reader)
	return &temp
}

func (c FfiConverterOptionalString) Lower(value *string) C.RustBuffer {
	return LowerIntoRustBuffer[*string](c, value)
}

func (c FfiConverterOptionalString) LowerExternal(value *string) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[*string](c, value))
}

func (_ FfiConverterOptionalString) Write(writer io.Writer, value *string) {
	if value == nil {
		writeInt8(writer, 0)
	} else {
		writeInt8(writer, 1)
		FfiConverterStringINSTANCE.Write(writer, *value)
	}
}

type FfiDestroyerOptionalString struct{}

func (_ FfiDestroyerOptionalString) Destroy(value *string) {
	if value != nil {
		FfiDestroyerString{}.Destroy(*value)
	}
}

type FfiConverterOptionalBytes struct{}

var FfiConverterOptionalBytesINSTANCE = FfiConverterOptionalBytes{}

func (c FfiConverterOptionalBytes) Lift(rb RustBufferI) *[]byte {
	return LiftFromRustBuffer[*[]byte](c, rb)
}

func (_ FfiConverterOptionalBytes) Read(reader io.Reader) *[]byte {
	if readInt8(reader) == 0 {
		return nil
	}
	temp := FfiConverterBytesINSTANCE.Read(reader)
	return &temp
}

func (c FfiConverterOptionalBytes) Lower(value *[]byte) C.RustBuffer {
	return LowerIntoRustBuffer[*[]byte](c, value)
}

func (c FfiConverterOptionalBytes) LowerExternal(value *[]byte) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[*[]byte](c, value))
}

func (_ FfiConverterOptionalBytes) Write(writer io.Writer, value *[]byte) {
	if value == nil {
		writeInt8(writer, 0)
	} else {
		writeInt8(writer, 1)
		FfiConverterBytesINSTANCE.Write(writer, *value)
	}
}

type FfiDestroyerOptionalBytes struct{}

func (_ FfiDestroyerOptionalBytes) Destroy(value *[]byte) {
	if value != nil {
		FfiDestroyerBytes{}.Destroy(*value)
	}
}

type FfiConverterSequenceString struct{}

var FfiConverterSequenceStringINSTANCE = FfiConverterSequenceString{}

func (c FfiConverterSequenceString) Lift(rb RustBufferI) []string {
	return LiftFromRustBuffer[[]string](c, rb)
}

func (c FfiConverterSequenceString) Read(reader io.Reader) []string {
	length := readInt32(reader)
	if length == 0 {
		return nil
	}
	result := make([]string, 0, length)
	for i := int32(0); i < length; i++ {
		result = append(result, FfiConverterStringINSTANCE.Read(reader))
	}
	return result
}

func (c FfiConverterSequenceString) Lower(value []string) C.RustBuffer {
	return LowerIntoRustBuffer[[]string](c, value)
}

func (c FfiConverterSequenceString) LowerExternal(value []string) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[[]string](c, value))
}

func (c FfiConverterSequenceString) Write(writer io.Writer, value []string) {
	if len(value) > math.MaxInt32 {
		panic("[]string is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(value)))
	for _, item := range value {
		FfiConverterStringINSTANCE.Write(writer, item)
	}
}

type FfiDestroyerSequenceString struct{}

func (FfiDestroyerSequenceString) Destroy(sequence []string) {
	for _, value := range sequence {
		FfiDestroyerString{}.Destroy(value)
	}
}

type FfiConverterSequencePackageCore struct{}

var FfiConverterSequencePackageCoreINSTANCE = FfiConverterSequencePackageCore{}

func (c FfiConverterSequencePackageCore) Lift(rb RustBufferI) []*PackageCore {
	return LiftFromRustBuffer[[]*PackageCore](c, rb)
}

func (c FfiConverterSequencePackageCore) Read(reader io.Reader) []*PackageCore {
	length := readInt32(reader)
	if length == 0 {
		return nil
	}
	result := make([]*PackageCore, 0, length)
	for i := int32(0); i < length; i++ {
		result = append(result, FfiConverterPackageCoreINSTANCE.Read(reader))
	}
	return result
}

func (c FfiConverterSequencePackageCore) Lower(value []*PackageCore) C.RustBuffer {
	return LowerIntoRustBuffer[[]*PackageCore](c, value)
}

func (c FfiConverterSequencePackageCore) LowerExternal(value []*PackageCore) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[[]*PackageCore](c, value))
}

func (c FfiConverterSequencePackageCore) Write(writer io.Writer, value []*PackageCore) {
	if len(value) > math.MaxInt32 {
		panic("[]*PackageCore is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(value)))
	for _, item := range value {
		FfiConverterPackageCoreINSTANCE.Write(writer, item)
	}
}

type FfiDestroyerSequencePackageCore struct{}

func (FfiDestroyerSequencePackageCore) Destroy(sequence []*PackageCore) {
	for _, value := range sequence {
		FfiDestroyerPackageCore{}.Destroy(value)
	}
}

type FfiConverterSequenceDirectoryEntry struct{}

var FfiConverterSequenceDirectoryEntryINSTANCE = FfiConverterSequenceDirectoryEntry{}

func (c FfiConverterSequenceDirectoryEntry) Lift(rb RustBufferI) []DirectoryEntry {
	return LiftFromRustBuffer[[]DirectoryEntry](c, rb)
}

func (c FfiConverterSequenceDirectoryEntry) Read(reader io.Reader) []DirectoryEntry {
	length := readInt32(reader)
	if length == 0 {
		return nil
	}
	result := make([]DirectoryEntry, 0, length)
	for i := int32(0); i < length; i++ {
		result = append(result, FfiConverterDirectoryEntryINSTANCE.Read(reader))
	}
	return result
}

func (c FfiConverterSequenceDirectoryEntry) Lower(value []DirectoryEntry) C.RustBuffer {
	return LowerIntoRustBuffer[[]DirectoryEntry](c, value)
}

func (c FfiConverterSequenceDirectoryEntry) LowerExternal(value []DirectoryEntry) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[[]DirectoryEntry](c, value))
}

func (c FfiConverterSequenceDirectoryEntry) Write(writer io.Writer, value []DirectoryEntry) {
	if len(value) > math.MaxInt32 {
		panic("[]DirectoryEntry is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(value)))
	for _, item := range value {
		FfiConverterDirectoryEntryINSTANCE.Write(writer, item)
	}
}

type FfiDestroyerSequenceDirectoryEntry struct{}

func (FfiDestroyerSequenceDirectoryEntry) Destroy(sequence []DirectoryEntry) {
	for _, value := range sequence {
		FfiDestroyerDirectoryEntry{}.Destroy(value)
	}
}

type FfiConverterMapStringString struct{}

var FfiConverterMapStringStringINSTANCE = FfiConverterMapStringString{}

func (c FfiConverterMapStringString) Lift(rb RustBufferI) map[string]string {
	return LiftFromRustBuffer[map[string]string](c, rb)
}

func (_ FfiConverterMapStringString) Read(reader io.Reader) map[string]string {
	result := make(map[string]string)
	length := readInt32(reader)
	for i := int32(0); i < length; i++ {
		key := FfiConverterStringINSTANCE.Read(reader)
		value := FfiConverterStringINSTANCE.Read(reader)
		result[key] = value
	}
	return result
}

func (c FfiConverterMapStringString) Lower(value map[string]string) C.RustBuffer {
	return LowerIntoRustBuffer[map[string]string](c, value)
}

func (c FfiConverterMapStringString) LowerExternal(value map[string]string) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[map[string]string](c, value))
}

func (_ FfiConverterMapStringString) Write(writer io.Writer, mapValue map[string]string) {
	if len(mapValue) > math.MaxInt32 {
		panic("map[string]string is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(mapValue)))
	for key, value := range mapValue {
		FfiConverterStringINSTANCE.Write(writer, key)
		FfiConverterStringINSTANCE.Write(writer, value)
	}
}

type FfiDestroyerMapStringString struct{}

func (_ FfiDestroyerMapStringString) Destroy(mapValue map[string]string) {
	for key, value := range mapValue {
		FfiDestroyerString{}.Destroy(key)
		FfiDestroyerString{}.Destroy(value)
	}
}

type FfiConverterMapStringBytes struct{}

var FfiConverterMapStringBytesINSTANCE = FfiConverterMapStringBytes{}

func (c FfiConverterMapStringBytes) Lift(rb RustBufferI) map[string][]byte {
	return LiftFromRustBuffer[map[string][]byte](c, rb)
}

func (_ FfiConverterMapStringBytes) Read(reader io.Reader) map[string][]byte {
	result := make(map[string][]byte)
	length := readInt32(reader)
	for i := int32(0); i < length; i++ {
		key := FfiConverterStringINSTANCE.Read(reader)
		value := FfiConverterBytesINSTANCE.Read(reader)
		result[key] = value
	}
	return result
}

func (c FfiConverterMapStringBytes) Lower(value map[string][]byte) C.RustBuffer {
	return LowerIntoRustBuffer[map[string][]byte](c, value)
}

func (c FfiConverterMapStringBytes) LowerExternal(value map[string][]byte) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[map[string][]byte](c, value))
}

func (_ FfiConverterMapStringBytes) Write(writer io.Writer, mapValue map[string][]byte) {
	if len(mapValue) > math.MaxInt32 {
		panic("map[string][]byte is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(mapValue)))
	for key, value := range mapValue {
		FfiConverterStringINSTANCE.Write(writer, key)
		FfiConverterBytesINSTANCE.Write(writer, value)
	}
}

type FfiDestroyerMapStringBytes struct{}

func (_ FfiDestroyerMapStringBytes) Destroy(mapValue map[string][]byte) {
	for key, value := range mapValue {
		FfiDestroyerString{}.Destroy(key)
		FfiDestroyerBytes{}.Destroy(value)
	}
}

type FfiConverterMapStringPackageCommandDefinition struct{}

var FfiConverterMapStringPackageCommandDefinitionINSTANCE = FfiConverterMapStringPackageCommandDefinition{}

func (c FfiConverterMapStringPackageCommandDefinition) Lift(rb RustBufferI) map[string]PackageCommandDefinition {
	return LiftFromRustBuffer[map[string]PackageCommandDefinition](c, rb)
}

func (_ FfiConverterMapStringPackageCommandDefinition) Read(reader io.Reader) map[string]PackageCommandDefinition {
	result := make(map[string]PackageCommandDefinition)
	length := readInt32(reader)
	for i := int32(0); i < length; i++ {
		key := FfiConverterStringINSTANCE.Read(reader)
		value := FfiConverterPackageCommandDefinitionINSTANCE.Read(reader)
		result[key] = value
	}
	return result
}

func (c FfiConverterMapStringPackageCommandDefinition) Lower(value map[string]PackageCommandDefinition) C.RustBuffer {
	return LowerIntoRustBuffer[map[string]PackageCommandDefinition](c, value)
}

func (c FfiConverterMapStringPackageCommandDefinition) LowerExternal(value map[string]PackageCommandDefinition) ExternalCRustBuffer {
	return RustBufferFromC(LowerIntoRustBuffer[map[string]PackageCommandDefinition](c, value))
}

func (_ FfiConverterMapStringPackageCommandDefinition) Write(writer io.Writer, mapValue map[string]PackageCommandDefinition) {
	if len(mapValue) > math.MaxInt32 {
		panic("map[string]PackageCommandDefinition is too large to fit into Int32")
	}

	writeInt32(writer, int32(len(mapValue)))
	for key, value := range mapValue {
		FfiConverterStringINSTANCE.Write(writer, key)
		FfiConverterPackageCommandDefinitionINSTANCE.Write(writer, value)
	}
}

type FfiDestroyerMapStringPackageCommandDefinition struct{}

func (_ FfiDestroyerMapStringPackageCommandDefinition) Destroy(mapValue map[string]PackageCommandDefinition) {
	for key, value := range mapValue {
		FfiDestroyerString{}.Destroy(key)
		FfiDestroyerPackageCommandDefinition{}.Destroy(value)
	}
}

const (
	uniffiRustFuturePollReady      int8 = 0
	uniffiRustFuturePollMaybeReady int8 = 1
)

type rustFuturePollFunc func(C.uint64_t, C.UniffiRustFutureContinuationCallback, C.uint64_t)
type rustFutureCompleteFunc[T any] func(C.uint64_t, *C.RustCallStatus) T
type rustFutureFreeFunc func(C.uint64_t)

//export ffi_uniffiFutureContinuationCallback
func ffi_uniffiFutureContinuationCallback(data C.uint64_t, pollResult C.int8_t) {
	h := cgo.Handle(uintptr(data))
	waiter := h.Value().(chan int8)
	waiter <- int8(pollResult)
}

func uniffiRustCallAsync[E any, T any, F any](
	errConverter BufReader[E],
	completeFunc rustFutureCompleteFunc[F],
	liftFunc func(F) T,
	rustFuture C.uint64_t,
	pollFunc rustFuturePollFunc,
	freeFunc rustFutureFreeFunc,
) (T, E) {
	defer freeFunc(rustFuture)

	pollResult := int8(-1)
	waiter := make(chan int8, 1)

	chanHandle := cgo.NewHandle(waiter)
	defer chanHandle.Delete()

	for pollResult != uniffiRustFuturePollReady {
		pollFunc(
			rustFuture,
			(C.UniffiRustFutureContinuationCallback)(C.ffi_uniffiFutureContinuationCallback),
			C.uint64_t(chanHandle),
		)
		pollResult = <-waiter
	}

	var goValue T
	ffiValue, err := rustCallWithError(errConverter, func(status *C.RustCallStatus) F {
		return completeFunc(rustFuture, status)
	})
	if value := reflect.ValueOf(err); value.IsValid() && !value.IsZero() {
		return goValue, err
	}
	return liftFunc(ffiValue), err
}

//export ffi_uniffiFreeGorutine
func ffi_uniffiFreeGorutine(data C.uint64_t) {
	handle := cgo.Handle(uintptr(data))
	defer handle.Delete()

	guard := handle.Value().(chan struct{})
	guard <- struct{}{}
}
