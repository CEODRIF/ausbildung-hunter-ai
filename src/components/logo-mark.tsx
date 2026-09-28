export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-xl bg-[#2f6fed] font-bold text-white shadow-[0_8px_18px_rgba(47,111,237,0.22)]"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      A
    </span>
  );
}
