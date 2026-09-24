import SwiftUI

@main
struct WasmerPostgresApp: App {
  @StateObject private var database = DatabaseModel()

  var body: some Scene {
    WindowGroup {
      NavigationStack {
        ConsoleView(database: database)
          .navigationTitle("Postgres on iPhone")
          .navigationBarTitleDisplayMode(.inline)
      }
      .task { await database.start() }
    }
  }
}

private struct ConsoleView: View {
  @ObservedObject var database: DatabaseModel
  @State private var showReset = false
  @FocusState private var editing: Bool

  private let examples: [(String, String)] = [
    ("Version", "SELECT version();"),
    ("Create table", "CREATE TABLE IF NOT EXISTS notes (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body text NOT NULL, created_at timestamptz DEFAULT now());"),
    ("Insert", "INSERT INTO notes(body) VALUES ('Hello from Swift 🐘') RETURNING *;"),
    ("Read", "SELECT * FROM notes ORDER BY id;"),
    ("Tables", "SELECT tablename FROM pg_tables WHERE schemaname = 'public';"),
    ("JSON", "SELECT jsonb_build_object('runtime', 'Wasmer', 'client', 'Swift', 'answer', 42) AS result;"),
    ("Aggregate", "SELECT count(*) AS rows, sum(i) AS total FROM generate_series(1, 10000) AS i;")
  ]

  var body: some View {
    List {
      Section {
        HStack(spacing: 12) {
          Image(systemName: "externaldrive.fill").font(.title2).foregroundStyle(.teal)
          VStack(alignment: .leading, spacing: 4) {
            Text(database.status).font(.subheadline.weight(.medium))
            Text("Wasmer SDK · Swift PostgresNIO").font(.caption).foregroundStyle(.secondary)
          }
          Spacer(minLength: 0)
          if !database.ready { ProgressView() }
          else { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
        }
        if !database.ready, let progress = database.progress { ProgressView(value: progress) }
      } footer: {
        Text("A local database for trying SQL. Data lasts for this session.")
      }

      Section("Query") {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack {
            ForEach(examples, id: \.0) { name, sql in
              Button(name) { database.sql = sql }
                .font(.caption.weight(.medium)).buttonStyle(.bordered)
                .disabled(database.busy)
            }
          }
        }
        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 4, trailing: 12))
        TextEditor(text: $database.sql)
          .font(.system(.subheadline, design: .monospaced))
          .autocorrectionDisabled().textInputAutocapitalization(.never)
          .frame(minHeight: 130).focused($editing)
          .accessibilityLabel("SQL query")
        Button {
          editing = false
          Task { await database.run() }
        } label: {
          HStack {
            Image(systemName: "play.fill")
            Text(database.busy && database.ready ? "Running…" : "Run query")
            Spacer()
            if database.busy && database.ready { ProgressView() }
          }
        }
        .disabled(!database.ready || database.busy)
      }

      if let error = database.error {
        Section("Error") { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
      }
      if let result = database.result {
        Section {
          if result.columns.isEmpty { Label("Statement completed", systemImage: "checkmark.circle") }
          else {
            ScrollView(.horizontal) {
              Grid(alignment: .topLeading, horizontalSpacing: 20, verticalSpacing: 12) {
                GridRow {
                  ForEach(Array(result.columns.enumerated()), id: \.offset) { _, column in
                    Text(column).fontWeight(.semibold)
                  }
                }
                Divider()
                ForEach(Array(result.rows.enumerated()), id: \.offset) { _, row in
                  GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, value in
                      Text(value).frame(maxWidth: 340, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                  }
                }
              }
              .font(.system(.caption, design: .monospaced)).padding(.vertical, 4)
            }
          }
        } header: {
          HStack {
            Text("Results · \(result.totalRows) \(result.totalRows == 1 ? "row" : "rows")")
            Spacer()
            Text(String(format: "%.1f ms", result.seconds * 1000))
          }
        } footer: {
          if result.totalRows > 100 { Text("Showing the first 100 rows.") }
        }
      }
      if !database.history.isEmpty {
        Section("Recent queries") {
          ForEach(database.history, id: \.self) { sql in
            Button { database.sql = sql } label: {
              Text(sql).font(.system(.caption, design: .monospaced)).lineLimit(2)
            }.disabled(database.busy)
          }
        }
      }
      Section {
        DisclosureGroup("PostgreSQL log") {
          Text(database.log).font(.system(.caption2, design: .monospaced)).textSelection(.enabled)
        }
      }
    }
    .scrollDismissesKeyboard(.interactively)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Reset", systemImage: "arrow.clockwise") { showReset = true }.disabled(database.busy)
      }
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") { editing = false }
      }
    }
    .confirmationDialog("Reset the session and discard its data?", isPresented: $showReset, titleVisibility: .visible) {
      Button("Reset database", role: .destructive) { Task { await database.reset() } }
    }
  }
}
