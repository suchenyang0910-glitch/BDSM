import React from "react";
import { Alert, Input, Select, Space, Tag, Typography } from "antd";
import type { DelimitedInputMode, DelimitedInputState } from "../utils/delimitedTagInput";
import { analyzeDelimitedInput, formatDelimitedItems, previewTelegramHashtags } from "../utils/delimitedTagInput";

const { Text } = Typography;
const { TextArea } = Input;

type DelimitedTagInputProps = {
  value?: string[];
  onChange?: (next: string[]) => void;
  mode: DelimitedInputMode;
  disabled?: boolean;
  selectPlaceholder?: string;
  textareaPlaceholder?: string;
  onStateChange?: (state: DelimitedInputState) => void;
  previewLabel?: string;
};

const DelimitedTagInput: React.FC<DelimitedTagInputProps> = ({
  value = [],
  onChange,
  mode,
  disabled,
  selectPlaceholder,
  textareaPlaceholder,
  onStateChange,
  previewLabel,
}) => {
  const [textareaValue, setTextareaValue] = React.useState<string>(formatDelimitedItems(value));
  const sourceRef = React.useRef<"external" | "select" | "textarea">("external");
  const lastStateRef = React.useRef<string>("");

  const syncState = React.useCallback((state: DelimitedInputState) => {
    const signature = JSON.stringify(state);
    if (signature === lastStateRef.current) return;
    lastStateRef.current = signature;
    onStateChange?.(state);
  }, [onStateChange]);

  React.useEffect(() => {
    if (sourceRef.current === "textarea") return;
    setTextareaValue(formatDelimitedItems(value));
    syncState(analyzeDelimitedInput(value, mode));
  }, [mode, syncState, value]);

  const applyAnalyzedState = React.useCallback((state: DelimitedInputState, nextTextareaValue?: string) => {
    onChange?.(state.items);
    syncState(state);
    if (typeof nextTextareaValue === "string") setTextareaValue(nextTextareaValue);
  }, [onChange, syncState]);

  const handleSelectChange = (rawValues: string[]) => {
    sourceRef.current = "select";
    const state = analyzeDelimitedInput(rawValues, mode);
    const formatted = formatDelimitedItems(state.items);
    applyAnalyzedState(state, formatted);
  };

  const handleTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    sourceRef.current = "textarea";
    const nextValue = event.target.value;
    setTextareaValue(nextValue);
    const state = analyzeDelimitedInput(nextValue, mode);
    applyAnalyzedState(state);
  };

  const handleTextareaBlur = () => {
    sourceRef.current = "external";
    const state = analyzeDelimitedInput(textareaValue, mode);
    setTextareaValue(formatDelimitedItems(state.items));
    syncState(state);
  };

  const currentState = React.useMemo(() => analyzeDelimitedInput(textareaValue || value, mode), [mode, textareaValue, value]);
  const previewTags = React.useMemo(
    () => (mode === "telegram" ? previewTelegramHashtags(currentState.items) : []),
    [currentState.items, mode],
  );

  return (
    <Space direction="vertical" size={8} style={{ width: "100%" }}>
      <Select
        mode="tags"
        value={value}
        onChange={handleSelectChange}
        placeholder={selectPlaceholder}
        disabled={disabled}
        tokenSeparators={[","]}
        style={{ width: "100%" }}
      />
      <TextArea
        rows={3}
        value={textareaValue}
        onChange={handleTextareaChange}
        onBlur={handleTextareaBlur}
        placeholder={textareaPlaceholder}
        disabled={disabled}
      />
      <Space direction="vertical" size={4} style={{ width: "100%" }}>
        <Text type={currentState.errors.length ? "danger" : "secondary"}>
          有效项 {currentState.items.length}/{currentState.maxCount}
        </Text>
        {mode === "telegram" && previewTags.length > 0 && (
          <div>
            <Text type="secondary">{previewLabel || "Telegram 预览"}：</Text>
            <Space wrap size={[6, 6]} style={{ marginTop: 6 }}>
              {previewTags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
            </Space>
          </div>
        )}
        {currentState.errors.length > 0 && (
          <Alert
            type="error"
            showIcon
            message="发现无效项"
            description={
              <Space direction="vertical" size={2}>
                {currentState.errors.map((issue, index) => (
                  <Text key={`${issue.code}-${issue.index}-${index}`} type="danger">
                    {issue.input || "(空项)"}：{issue.message}
                  </Text>
                ))}
              </Space>
            }
          />
        )}
      </Space>
    </Space>
  );
};

export default DelimitedTagInput;
