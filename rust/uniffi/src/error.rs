use std::fmt;

#[derive(Debug, uniffi::Error)]
pub enum SdkError {
    Failure { code: String, message: String },
}

impl SdkError {
    pub(crate) fn invalid_argument(message: impl Into<String>) -> Self {
        Self::Failure {
            code: "INVALID_ARGUMENT".to_owned(),
            message: message.into(),
        }
    }

    pub(crate) fn task(message: impl Into<String>) -> Self {
        Self::Failure {
            code: "TASK_ERROR".to_owned(),
            message: message.into(),
        }
    }
}

impl From<wasmer_sdk::Error> for SdkError {
    fn from(error: wasmer_sdk::Error) -> Self {
        Self::Failure {
            code: error.code().to_owned(),
            message: error.to_string(),
        }
    }
}

impl From<std::io::Error> for SdkError {
    fn from(error: std::io::Error) -> Self {
        Self::Failure {
            code: "IO_ERROR".to_owned(),
            message: error.to_string(),
        }
    }
}

impl fmt::Display for SdkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Failure { message, .. } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for SdkError {}
