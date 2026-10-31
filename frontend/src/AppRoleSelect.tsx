export type AppRoleOption = { id: string; label: string };
export default function AppRoleSelect({
  name,
  roles,
  value,
  disabled,
  onChange,
}: {
  name: string;
  roles: AppRoleOption[];
  value: string | null;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <select
      aria-label={"App role for " + name}
      value={value || ""}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">No app role</option>
      {roles.map((role) => (
        <option key={role.id} value={role.id}>
          {role.label}
        </option>
      ))}
    </select>
  );
}
