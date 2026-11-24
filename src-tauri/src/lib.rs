mod llm;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(workspace::Workspace::default())
        // Remember what the OS dropped onto the window; `import_dropped` only
        // copies those paths.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                use tauri::Manager;
                window.state::<workspace::Workspace>().remember_drop(paths.clone());
            }
        })
        .setup(|app| {
            use tauri::Manager;
            use tauri_plugin_opener::OpenerExt;
            let config_dir = app.path().app_config_dir()?;
            let handle = app.handle().clone();
            let open_browser = Box::new(move |url: &str| {
                handle.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
            });
            app.manage(llm::LlmState::new(config_dir, open_browser));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace::open_workspace,
            workspace::list_tree,
            workspace::read_text_file,
            workspace::read_binary_file,
            workspace::read_text_file_opt,
            workspace::write_text_file,
            workspace::list_dir,
            workspace::delete_app_file,
            workspace::import_files,
            workspace::import_dropped,
            workspace::move_file,
            workspace::trash_file,
            llm::llm_ask,
            llm::llm_cancel,
            llm::llm_list_models,
            llm::llm_default_model,
            llm::llm_auth_status,
            llm::chatgpt_sign_in,
            llm::chatgpt_cancel_sign_in,
            llm::chatgpt_sign_out,
            llm::chatgpt_account,
            llm::chatgpt_ack_welcome,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
