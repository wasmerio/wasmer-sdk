use anyhow::Context;
use js_sys::{BigInt, JsString, Object, Reflect};
use serde::de::DeserializeOwned;
use wasm_bindgen::{JsCast, JsValue};

use crate::worker_utils::Error;

const TYPE: &str = "type";

#[derive(Debug, Clone)]
pub(crate) struct Deserializer {
    value: JsValue,
}

impl Deserializer {
    /// # Safety
    /// Only decode messages produced by this runtime's Serializer protocol.
    pub unsafe fn new(value: JsValue) -> Result<Self, Error> {
        let value =
            unsafe { wasmer::js::receive_shared_object_message(value) }.map_err(Error::js)?;
        Ok(Deserializer { value })
    }

    pub fn string(&self, field: &str) -> Result<String, Error> {
        let string: JsString = self.js(field)?;
        Ok(string.into())
    }

    pub fn ty(&self) -> Result<String, Error> {
        self.string(TYPE)
    }

    pub fn serde<T: DeserializeOwned>(&self, field: &str) -> Result<T, Error> {
        let raw: JsValue = self.js(field)?;
        let deserialized = serde_wasm_bindgen::from_value(raw).map_err(Error::js)?;
        Ok(deserialized)
    }

    /// Deserialize a field by interpreting it as a pointer to some boxed object
    /// and unboxing it.
    ///
    /// # Safety
    ///
    /// The object being deserialized must have been created by a [`Serializer`]
    /// and the field must have been initialized using [`Serializer::boxed()`].
    pub unsafe fn boxed<T>(&self, field: &str) -> Result<T, Error> {
        let raw_address: BigInt = self.js(field)?;
        let address = u64::try_from(raw_address).unwrap() as usize as *mut T;
        let boxed = unsafe { Box::from_raw(address) };
        Ok(*boxed)
    }

    pub fn js<T>(&self, field: &str) -> Result<T, Error>
    where
        T: JsCast,
    {
        let value = Reflect::get(&self.value, &JsValue::from_str(field)).map_err(Error::js)?;
        let value = value.dyn_into().map_err(|_| {
            anyhow::anyhow!(
                "The \"{field}\" field isn't a \"{}\"",
                std::any::type_name::<T>()
            )
        })?;
        Ok(value)
    }
}

#[derive(Debug)]
pub(crate) struct Serializer {
    obj: Object,
    error: Option<Error>,
    has_task: bool,
}

impl Serializer {
    pub fn new(ty: &str) -> Self {
        let ser = Serializer {
            obj: Object::new(),
            error: None,
            has_task: false,
        };

        ser.set(TYPE, ty)
    }

    pub fn set(mut self, field: impl AsRef<str>, value: impl Into<JsValue>) -> Self {
        if self.error.is_some() {
            // Short-circuit.
            return self;
        }

        let field = field.as_ref();

        if let Err(e) = Reflect::set(&self.obj, &JsValue::from_str(field), &value.into())
            .map_err(crate::worker_utils::js_error)
            .with_context(|| format!("Unable to set \"{field}\""))
        {
            self.error = Some(e.into());
        }

        self
    }

    /// Serialize a field by boxing it and passing the address to
    /// `postMessage()`.
    pub fn boxed<T: Send>(mut self, field: &str, value: T) -> Self {
        self.has_task = true;
        let ptr = Box::into_raw(Box::new(value));
        self.set(field, BigInt::from(ptr as usize))
    }

    pub fn finish(self) -> Result<JsValue, Error> {
        wasmer::js::collect_shared_objects();
        let Serializer {
            obj,
            error,
            has_task,
        } = self;
        match error {
            None => Ok(if has_task {
                wasmer::js::prepare_shared_object_message(obj.into())
            } else {
                obj.into()
            }),
            Some(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Deserializer, Serializer};
    use crate::tasks::{BlockingJob, PostMessagePayload, SchedulerMessage, WorkerMessage};
    use js_sys::{Array, WebAssembly};
    use wasm_bindgen::{JsCast, JsValue};
    use wasm_bindgen_test::wasm_bindgen_test;
    use wasmer::{Memory, MemoryType, Module, SharedMemory, Store};

    #[wasm_bindgen_test]
    fn lifecycle_messages_stay_plain_with_live_objects() {
        let store = Store::default();
        let _module = Module::new(&store, b"\0asm\x01\0\0\0").unwrap();
        let messages = [
            WorkerMessage::MarkBusy.into_js().unwrap(),
            WorkerMessage::MarkIdle.into_js().unwrap(),
            SchedulerMessage::Close {
                completion: None,
                drain: false,
            }
            .into_js()
            .unwrap(),
            WorkerMessage::Scheduler(SchedulerMessage::WorkerBusy { worker_id: 1 })
                .into_js()
                .unwrap(),
            SchedulerMessage::TerminateWasmThread { pid: 1, tid: 1 }
                .into_js()
                .unwrap(),
        ];
        for message in messages {
            assert!(!Array::is_array(&message));
        }
        let task = PostMessagePayload::Blocking(BlockingJob::Thunk(Box::new(|| {})))
            .into_js()
            .unwrap();
        assert!(Array::is_array(&task));
        // Decode exactly once to reclaim the boxed task.
        drop(unsafe { PostMessagePayload::try_from_js(task) }.unwrap());
    }

    #[wasm_bindgen_test]
    fn boxed_values_include_module_and_shared_memory() {
        let mut store = Store::default();
        let module = Module::new(&store, b"\0asm\x01\0\0\0").unwrap();
        let memory = Memory::new(&mut store, MemoryType::new(1, Some(2), true)).unwrap();
        memory.view(&store).write(0, &[42]).unwrap();
        let shared = memory.as_shared(&store).unwrap();
        drop(memory);
        let message = Serializer::new("test-task")
            .boxed("payload", (module, shared))
            .finish()
            .unwrap();
        let snapshot = Array::from(&Array::from(&message).get(2));
        assert_eq!(snapshot.length(), 2);
        assert!(snapshot.iter().any(|entry| {
            Array::from(&entry)
                .get(1)
                .is_instance_of::<WebAssembly::Module>()
        }));
        assert!(snapshot.iter().any(|entry| {
            Array::from(&entry)
                .get(1)
                .is_instance_of::<WebAssembly::Memory>()
        }));
        let de = unsafe { Deserializer::new(message) }.unwrap();
        assert_eq!(de.ty().unwrap(), "test-task");
        let (module, shared): (Module, SharedMemory) = unsafe { de.boxed("payload") }.unwrap();
        let _: WebAssembly::Module = module.into();
        let memory = shared.attach(&mut store);
        let mut byte = [0];
        memory.view(&store).read(0, &mut byte).unwrap();
        assert_eq!(byte, [42]);
    }

    #[wasm_bindgen_test]
    fn invalid_envelope_does_not_consume_the_task() {
        let message = Serializer::new("test-task")
            .boxed("payload", 42u32)
            .finish()
            .unwrap();
        let invalid = Array::from(&message).slice(0, 3);
        invalid.set(0, JsValue::from_str("another-runtime"));
        assert!(unsafe { Deserializer::new(invalid.into()) }.is_err());
        let de = unsafe { Deserializer::new(message) }.unwrap();
        let value: u32 = unsafe { de.boxed("payload") }.unwrap();
        assert_eq!(value, 42);
    }
}
