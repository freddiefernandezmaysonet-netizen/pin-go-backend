export function Skeleton({
  width = "100%",
  height = 16,
  style = {},
}: {
  width?: string | number;
  height?: number;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 6,
        background:
          "linear-gradient(90deg, #f3f4f6 25%, #e5e7eb 37%, #f3f4f6 63%)",
        backgroundSize: "400% 100%",
        animation: "skeleton-loading 1.4s ease infinite",
        ...style,
      }}
    />
  );
}