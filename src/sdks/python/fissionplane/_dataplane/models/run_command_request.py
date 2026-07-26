from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.run_command_request_env import RunCommandRequestEnv


T = TypeVar("T", bound="RunCommandRequest")


@_attrs_define
class RunCommandRequest:
    """
    Attributes:
        command (str): The program to run.
        args (list[str] | Unset):
        cwd (str | Unset): Working directory. Omitted means the default user's home.
        env (RunCommandRequestEnv | Unset): Environment variables set for this command only.
        stdin (str | Unset): Bytes written to the command's stdin before it is closed.
        timeout_seconds (int | Unset): Kill the command if it has not exited after this long.
            Omitted means the agent's default.
    """

    command: str
    args: list[str] | Unset = UNSET
    cwd: str | Unset = UNSET
    env: RunCommandRequestEnv | Unset = UNSET
    stdin: str | Unset = UNSET
    timeout_seconds: int | Unset = UNSET
    additional_properties: dict[str, Any] = _attrs_field(init=False, factory=dict)

    def to_dict(self) -> dict[str, Any]:
        command = self.command

        args: list[str] | Unset = UNSET
        if not isinstance(self.args, Unset):
            args = self.args

        cwd = self.cwd

        env: dict[str, Any] | Unset = UNSET
        if not isinstance(self.env, Unset):
            env = self.env.to_dict()

        stdin = self.stdin

        timeout_seconds = self.timeout_seconds

        field_dict: dict[str, Any] = {}
        field_dict.update(self.additional_properties)
        field_dict.update(
            {
                "command": command,
            }
        )
        if args is not UNSET:
            field_dict["args"] = args
        if cwd is not UNSET:
            field_dict["cwd"] = cwd
        if env is not UNSET:
            field_dict["env"] = env
        if stdin is not UNSET:
            field_dict["stdin"] = stdin
        if timeout_seconds is not UNSET:
            field_dict["timeout_seconds"] = timeout_seconds

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.run_command_request_env import RunCommandRequestEnv

        d = dict(src_dict)
        command = d.pop("command")

        args = cast(list[str], d.pop("args", UNSET))

        cwd = d.pop("cwd", UNSET)

        _env = d.pop("env", UNSET)
        env: RunCommandRequestEnv | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = RunCommandRequestEnv.from_dict(_env)

        stdin = d.pop("stdin", UNSET)

        timeout_seconds = d.pop("timeout_seconds", UNSET)

        run_command_request = cls(
            command=command,
            args=args,
            cwd=cwd,
            env=env,
            stdin=stdin,
            timeout_seconds=timeout_seconds,
        )

        run_command_request.additional_properties = d
        return run_command_request

    @property
    def additional_keys(self) -> list[str]:
        return list(self.additional_properties.keys())

    def __getitem__(self, key: str) -> Any:
        return self.additional_properties[key]

    def __setitem__(self, key: str, value: Any) -> None:
        self.additional_properties[key] = value

    def __delitem__(self, key: str) -> None:
        del self.additional_properties[key]

    def __contains__(self, key: str) -> bool:
        return key in self.additional_properties
