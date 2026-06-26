//! GBNF (GGML BNF) grammar string constants and builders.
//!
//! Pass the resulting string as `"grammar"` in the llama-server completion
//! request body to constrain logit sampling so output *cannot* be malformed JSON.
//!
//! This is the single biggest accuracy lever: the model's search space is
//! narrowed → fewer wasted tokens → faster generation (revamp.md §5.3).

/// Permissive JSON value grammar — allows any well-formed JSON.
pub const JSON_VALUE_GBNF: &str = r#"root   ::= value
value  ::= object | array | string | number | ("true" | "false" | "null") ws
object ::= "{" ws (string ":" ws value ("," ws string ":" ws value)*)? "}" ws
array  ::= "[" ws (value ("," ws value)*)? "]" ws
string ::= "\"" (
    [^"\\] |
    "\\" (["\\/bfnrt] | "u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])
  )* "\"" ws
number ::= ("-"? ([0-9] | [1-9] [0-9]*)) ("." [0-9]+)? (([eE] [-+]? [0-9]+))? ws
ws     ::= ([ \t\n] ws)?
"#;

/// Grammar for the spreadsheet functional-schema plan.
///
/// Constrains the SLM to emit only valid `SpreadsheetPlan` JSON with operations
/// from the approved vocabulary (revamp.md §5.1 — Functional Schema Library).
pub const SPREADSHEET_PLAN_GBNF: &str = r#"root      ::= "{" ws "\"ops\"" ws ":" ws "[" ws op-list "]" ws "}"
op-list   ::= op ("," ws op)*
op        ::= sum-op | avg-op | pivot-op | sort-desc-op | sort-asc-op | filter-op | count-op | add-col-op | write-data-op | rename-op

sum-op    ::= "{" ws "\"op\"" ws ":" ws "\"SUM_COLUMN\"" ws "," ws "\"col\"" ws ":" ws string ws ("," ws "\"label\"" ws ":" ws string)? ws "}"
avg-op    ::= "{" ws "\"op\"" ws ":" ws "\"AVERAGE_BY_GROUP\"" ws "," ws "\"value_col\"" ws ":" ws string ws "," ws "\"group_col\"" ws ":" ws string ws "}"
pivot-op  ::= "{" ws "\"op\"" ws ":" ws "\"PIVOT\"" ws "," ws "\"row_col\"" ws ":" ws string ws "," ws "\"col_col\"" ws ":" ws string ws "," ws "\"value_col\"" ws ":" ws string ws "}"
sort-desc-op ::= "{" ws "\"op\"" ws ":" ws "\"SORT_DESC\"" ws "," ws "\"col\"" ws ":" ws string ws "}"
sort-asc-op  ::= "{" ws "\"op\"" ws ":" ws "\"SORT_ASC\"" ws "," ws "\"col\"" ws ":" ws string ws "}"
filter-op ::= "{" ws "\"op\"" ws ":" ws "\"FILTER_ROWS\"" ws "," ws "\"col\"" ws ":" ws string ws "," ws "\"value\"" ws ":" ws string ws "}"
count-op  ::= "{" ws "\"op\"" ws ":" ws "\"COUNT_BY_GROUP\"" ws "," ws "\"group_col\"" ws ":" ws string ws "}"
add-col-op ::= "{" ws "\"op\"" ws ":" ws "\"ADD_COLUMN\"" ws "," ws "\"name\"" ws ":" ws string ws "," ws "\"formula\"" ws ":" ws string ws "}"
write-data-op ::= "{" ws "\"op\"" ws ":" ws "\"WRITE_DATA\"" ws "," ws "\"headers\"" ws ":" ws str-array ws "," ws "\"rows\"" ws ":" ws str-array-array ws "}"
rename-op ::= "{" ws "\"op\"" ws ":" ws "\"RENAME_SHEET\"" ws "," ws "\"name\"" ws ":" ws string ws "}"

str-array ::= "[" ws (string ("," ws string)*)? "]" ws
str-array-array ::= "[" ws (str-array ("," ws str-array)*)? "]" ws
string    ::= "\"" ([^"\\] | "\\" .)* "\"" ws
number    ::= "-"? [0-9]+ ("." [0-9]+)?
ws        ::= ([ \t\n] ws)?
"#;

/// Grammar for the presentation functional-schema plan.
///
/// Constrains the SLM to emit only valid `PresentationPlan` JSON with
/// approved layout types.
pub const PRESENTATION_PLAN_GBNF: &str = r#"root         ::= "{" ws "\"slides\"" ws ":" ws "[" ws slide-list "]" ws ("," ws theme-field)? ws "}"
theme-field  ::= "\"theme\"" ws ":" ws theme-name
theme-name   ::= "\"midnight\"" | "\"corporate\"" | "\"sunset\"" | "\"minimal\"" | "\"academic\"" | "\"cyber\"" | "\"ocean\"" | "\"forest\"" | "\"lavender\"" | "\"neon\"" | "\"rose\"" | "\"slate\""
slide-list   ::= slide ("," ws slide)*
slide        ::= "{" ws "\"title\"" ws ":" ws string ws
                 "," ws "\"layout\"" ws ":" ws layout-type ws
                 ("," ws "\"bullets\"" ws ":" ws bullet-list)?
                 ("," ws "\"notes\"" ws ":" ws string)?
                 ("," ws "\"image_index\"" ws ":" ws number)?
                 ("," ws "\"left_title\"" ws ":" ws string)?
                 ("," ws "\"right_title\"" ws ":" ws string)?
                 ws "}"
layout-type  ::= "\"TITLE\"" | "\"BULLET\"" | "\"TWO_COLUMN\"" | "\"IMAGE_LEFT\"" | "\"BLANK\"" | "\"SECTION\"" | "\"STAT\"" | "\"QUOTE\"" | "\"CARDS\"" | "\"COMPARISON\"" | "\"CENTERED\""
bullet-list  ::= "[" ws (string ("," ws string)*)? "]" ws
number       ::= [0-9]+ ws
string       ::= "\"" ([^"\\] | "\\" .)* "\"" ws
ws           ::= ([ \t\n] ws)?
"#;

/// Grammar for HTML page synthesis (structured plan — rendered deterministically).
pub const HTML_PAGE_PLAN_GBNF: &str = r#"root            ::= "{" ws title-field "," ws archetype-field ("," ws tagline-field)? "," ws sections-field ("," ws theme-field)? ("," ws output-field)? ws "}"
title-field     ::= "\"title\"" ws ":" ws string
tagline-field   ::= "\"tagline\"" ws ":" ws string
archetype-field ::= "\"archetype\"" ws ":" ws archetype
theme-field     ::= "\"theme\"" ws ":" ws theme-name
output-field    ::= "\"output_name\"" ws ":" ws string
sections-field  ::= "\"sections\"" ws ":" ws "[" ws section-list "]"
section-list    ::= section ("," ws section)*
section         ::= "{" ws "\"kind\"" ws ":" ws section-kind "," ws "\"title\"" ws ":" ws string ("," ws "\"subtitle\"" ws ":" ws string)? ("," ws "\"body\"" ws ":" ws string)? ("," ws chart-type-field)? ("," ws label-col-field)? ("," ws value-col-field)? ("," ws agg-field)? ("," ws image-index-field)? ("," ws "\"items\"" ws ":" ws item-list)? ws "}"
section-kind    ::= "\"HERO\"" | "\"INFO_BAR\"" | "\"GRID\"" | "\"SPLIT\"" | "\"STATS\"" | "\"QUOTES\"" | "\"FAQ\"" | "\"CTA\"" | "\"TEXT\"" | "\"CHART\"" | "\"IMAGE\""
image-index-field ::= "\"image_index\"" ws ":" ws number
number          ::= [0-9]+ ws
chart-type-field ::= "\"chart_type\"" ws ":" ws chart-type
chart-type      ::= "\"bar\"" | "\"pie\"" | "\"line\""
label-col-field ::= "\"label_column\"" ws ":" ws string
value-col-field ::= "\"value_column\"" ws ":" ws string
agg-field       ::= "\"aggregation\"" ws ":" ws aggregation
aggregation     ::= "\"sum\"" | "\"count\"" | "\"avg\"" | "\"min\"" | "\"max\""
item-list       ::= "[" ws (item ("," ws item)*)? "]"
item            ::= "{" ws "\"label\"" ws ":" ws string ("," ws "\"detail\"" ws ":" ws string)? ("," ws "\"meta\"" ws ":" ws string)? ws "}"
archetype       ::= "\"landing\"" | "\"local_business\"" | "\"article\"" | "\"portfolio\"" | "\"dashboard\"" | "\"documentation\"" | "\"event\"" | "\"comparison\"" | "\"catalog\"" | "\"resume\"" | "\"infographic\"" | "\"newsletter\"" | "\"interactive\""
theme-name      ::= "\"midnight\"" | "\"corporate\"" | "\"sunset\"" | "\"minimal\"" | "\"forest\"" | "\"rose\"" | "\"cyber\"" | "\"ocean\"" | "\"academic\"" | "\"lavender\"" | "\"neon\"" | "\"slate\"" | "\"aurora\"" | "\"paper\""
string          ::= "\"" ([^"\\] | "\\" .)* "\"" ws
ws              ::= ([ \t\n] ws)?
"#;

/// Build a JSON object grammar constrained to a fixed set of allowed keys.
///
/// Values may be any JSON type (string, number, bool, null, object, array).
/// Unknown keys cannot be generated — the model is forced to use a key from
/// the allowlist.
pub fn json_object_with_keys(keys: &[&str]) -> String {
    if keys.is_empty() {
        return "root ::= \"{\" ws \"}\" ws\nws ::= ([ \\t\\n] ws)?\n".to_string();
    }

    // Quoted key literals for the GBNF union rule.
    let key_union: String = keys
        .iter()
        .map(|k| format!("\"\\\"{}\\\"\"", k))
        .collect::<Vec<_>>()
        .join(" | ");

    format!(
        r#"allowed-key ::= {key_union}
root    ::= "{{" ws pair ("," ws pair)* "}}" ws
pair    ::= allowed-key ws ":" ws value ws
value   ::= string | number | "true" | "false" | "null" | object | array
object  ::= "{{" ws (pair ("," ws pair)*)? "}}" ws
array   ::= "[" ws (value ("," ws value)*)? "]" ws
string  ::= "\"" ([^"\\] | "\\" .)* "\"" ws
number  ::= "-"? [0-9]+ ("." [0-9]+)? ([eE] [-+]? [0-9]+)?
ws      ::= ([ \t\n] ws)?
"#
    )
}
