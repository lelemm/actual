use crate::{load_config::Config, migrations};

pub use crate::migrations::Direction;

pub fn run(config: &Config, direction: Direction) -> Result<(), Box<dyn std::error::Error>> {
    migrations::run_direction(config, direction)
}
