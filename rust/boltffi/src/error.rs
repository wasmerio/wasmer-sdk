use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SdkError {
    pub code: String,
    pub message: String,
}

impl SdkError {
    pub(crate) fn invalid_argument(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_ARGUMENT".to_owned(),
            message: message.into(),
        }
    }

    pub(crate) fn task(message: impl Into<String>) -> Self {
        Self {
            code: "TASK_ERROR".to_owned(),
            message: message.into(),
        }
    }
}

impl From<wasmer_sdk::Error> for SdkError {
    fn from(error: wasmer_sdk::Error) -> Self {
        Self {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

impl From<std::io::Error> for SdkError {
    fn from(error: std::io::Error) -> Self {
        Self {
            code: "IO_ERROR".to_owned(),
            message: error.to_string(),
        }
    }
}

impl fmt::Display for SdkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl From<SdkError> for String {
    fn from(error: SdkError) -> Self {
        format!("{}: {}", error.code, error.message)
    }
}
