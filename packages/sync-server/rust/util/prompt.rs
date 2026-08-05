use std::{
    io::{self, BufRead, BufReader, IsTerminal, Write},
    sync::OnceLock,
};

pub fn prompt_password() -> Result<String, std::io::Error> {
    install_interrupt_handler()?;
    let result = if io::stdin().is_terminal() {
        prompt_terminal()
    } else {
        prompt_redirected(&mut BufReader::new(io::stdin()), &mut io::stdout())
    };
    if result.as_ref().is_err_and(is_clean_exit) {
        std::process::exit(0);
    }
    result
}

fn prompt_terminal() -> io::Result<String> {
    loop {
        let password = ask_terminal("Enter a password, then press enter: ")?;
        if let Some(error) = pair_error(&password, &password) {
            println!("{error}");
            continue;
        }
        let confirmation = ask_terminal("Enter the password again, then press enter: ")?;
        if let Some(error) = pair_error(&password, &confirmation) {
            println!("{error}");
            continue;
        }

        return Ok(password);
    }
}

fn prompt_redirected(input: &mut impl BufRead, output: &mut impl Write) -> io::Result<String> {
    loop {
        let password = read_redirected(input, output, "Enter a password, then press enter: ")?
            .ok_or_else(unexpected_eof)?;
        if let Some(error) = pair_error(&password, &password) {
            writeln!(output, "{error}")?;
            continue;
        }
        let confirmation = read_redirected(
            input,
            output,
            "Enter the password again, then press enter: ",
        )?
        .ok_or_else(unexpected_eof)?;
        if let Some(error) = pair_error(&password, &confirmation) {
            writeln!(output, "{error}")?;
            continue;
        }
        return Ok(password);
    }
}

fn pair_error(password: &str, confirmation: &str) -> Option<&'static str> {
    if password.is_empty() {
        Some("Password cannot be empty.")
    } else if password != confirmation {
        Some("Passwords do not match.")
    } else {
        None
    }
}

fn ask_terminal(prompt: &str) -> io::Result<String> {
    rpassword::prompt_password_with_config(prompt, terminal_config())
}

fn terminal_config() -> rpassword::Config {
    rpassword::ConfigBuilder::new()
        .password_feedback_mask('*')
        .build()
}

fn read_redirected(
    input: &mut impl BufRead,
    output: &mut impl Write,
    prompt: &str,
) -> io::Result<Option<String>> {
    output.write_all(prompt.as_bytes())?;
    output.flush()?;
    let mut value = Vec::new();
    let read = input.read_until(b'\n', &mut value)?;
    if value.contains(&3) {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "interrupted"));
    }
    output.write_all(b"\n")?;
    output.flush()?;
    if read == 0 {
        return Ok(None);
    }
    while matches!(value.last(), Some(b'\n' | b'\r')) {
        value.pop();
    }
    Ok(Some(String::from_utf8_lossy(&value).into_owned()))
}

fn unexpected_eof() -> io::Error {
    io::Error::new(io::ErrorKind::UnexpectedEof, "unexpected end of input")
}

fn is_clean_exit(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Interrupted | io::ErrorKind::UnexpectedEof
    )
}

fn install_interrupt_handler() -> io::Result<()> {
    static HANDLER: OnceLock<Result<(), String>> = OnceLock::new();
    HANDLER
        .get_or_init(|| ctrlc::set_handler(|| {}).map_err(|error| error.to_string()))
        .clone()
        .map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use std::{
        io::{Cursor, Write},
        process::{Command, Stdio},
    };

    #[test]
    fn password_pair_requires_non_empty_matching_values() {
        assert_eq!(super::pair_error("secret", "secret"), None);
        assert_eq!(super::pair_error("", ""), Some("Password cannot be empty."));
        assert_eq!(
            super::pair_error("secret", "different"),
            Some("Passwords do not match.")
        );
    }

    #[test]
    fn interrupt_handler_is_installed_once() {
        assert!(super::install_interrupt_handler().is_ok());
        assert!(super::install_interrupt_handler().is_ok());
        assert!(super::is_clean_exit(&std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "interrupted",
        )));
        assert!(super::is_clean_exit(&std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "eof",
        )));
    }

    #[test]
    fn redirected_stdio_reads_input_and_finishes_the_prompt_line() {
        let mut input = Cursor::new(b"secret\n");
        let mut output = Vec::new();
        let password = super::read_redirected(&mut input, &mut output, "Password: ")
            .unwrap()
            .unwrap();

        assert_eq!(password, "secret");
        assert_eq!(output, b"Password: \n");
    }

    #[test]
    fn redirected_mismatch_reuses_streams_and_eof_stops_once() {
        let mut input = Cursor::new(b"secret\ndifferent\n");
        let mut output = Vec::new();
        let error = super::prompt_redirected(&mut input, &mut output).unwrap_err();

        assert_eq!(error.kind(), std::io::ErrorKind::UnexpectedEof);
        assert_eq!(
            output,
            b"Enter a password, then press enter: \n\
              Enter the password again, then press enter: \n\
              Passwords do not match.\n\
              Enter a password, then press enter: \n"
        );
    }

    #[test]
    fn prompt_subprocess_helper() {
        if std::env::var_os("ACTUAL_PROMPT_SUBPROCESS").is_none() {
            return;
        }
        assert_eq!(super::prompt_password().unwrap(), "secret");
    }

    #[test]
    fn redirected_prompt_uses_process_stdio_and_ctrl_c_exits_cleanly() {
        let output = run_prompt_subprocess(
            &mut Command::new(std::env::current_exe().unwrap()),
            b"secret\nsecret\n",
        );
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).contains(
            "Enter a password, then press enter: \nEnter the password again, then press enter: \n"
        ));

        let interrupted =
            run_prompt_subprocess(&mut Command::new(std::env::current_exe().unwrap()), b"\x03");
        assert!(interrupted.status.success());

        let eof = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "util::prompt::tests::prompt_subprocess_helper",
                "--nocapture",
            ])
            .env("ACTUAL_PROMPT_SUBPROCESS", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
            .unwrap();
        assert!(eof.status.success());
        assert!(
            String::from_utf8_lossy(&eof.stdout)
                .ends_with("Enter a password, then press enter: \n")
        );
    }

    fn run_prompt_subprocess(command: &mut Command, input: &[u8]) -> std::process::Output {
        let mut child = command
            .args([
                "--exact",
                "util::prompt::tests::prompt_subprocess_helper",
                "--nocapture",
            ])
            .env("ACTUAL_PROMPT_SUBPROCESS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn prompt_masks_input_on_a_pty() {
        let executable = std::env::current_exe().unwrap();
        let command = format!(
            "ACTUAL_PROMPT_SUBPROCESS=1 '{}' --exact util::prompt::tests::prompt_subprocess_helper --nocapture",
            executable.display()
        );
        let mut script = Command::new("script");
        script.args(["-qec", &command, "/dev/null"]);
        let output = run_raw_subprocess(&mut script, b"secret\rsecret\r");

        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("Enter a password, then press enter: ******"));
        assert!(stdout.contains("Enter the password again, then press enter: ******"));
    }

    fn run_raw_subprocess(command: &mut Command, input: &[u8]) -> std::process::Output {
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(input).unwrap();
        child.wait_with_output().unwrap()
    }

    #[cfg(windows)]
    #[test]
    fn windows_interactive_prompt_keeps_rpassword_console_configuration() {
        let _ = super::terminal_config();
    }
}
