mod llm;
mod secrets;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(workspace::Workspace::default())
        .manage(llm::LlmState::new())
        .invoke_handler(tauri::generate_handler![
            workspace::open_workspace,
            workspace::list_tree,
            workspace::read_text_file,
            workspace::read_binary_file,
            workspace::read_text_file_opt,
            workspace::write_text_file,
            llm::llm_ask,
            llm::llm_cancel,
            llm::llm_list_models,
            llm::llm_default_model,
            secrets::set_api_key,
            secrets::has_api_key,
            secrets::delete_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
