from __future__ import annotations

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, TypeVar, cast

from attrs import define as _attrs_define
from attrs import field as _attrs_field

from ..types import UNSET, Unset

if TYPE_CHECKING:
    from ..models.pty_size import PtySize
    from ..models.start_process_request_env import StartProcessRequestEnv


T = TypeVar("T", bound="StartProcessRequest")


@_attrs_define
class StartProcessRequest:
    """
    Attributes:
        command (str):
        args (list[str] | Unset):
        cwd (str | Unset):
        env (StartProcessRequestEnv | Unset):
        pty (PtySize | Unset):
    """

    command: str
    args: list[str] | Unset = UNSET
    cwd: str | Unset = UNSET
    env: StartProcessRequestEnv | Unset = UNSET
    pty: PtySize | Unset = UNSET
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

        pty: dict[str, Any] | Unset = UNSET
        if not isinstance(self.pty, Unset):
            pty = self.pty.to_dict()

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
        if pty is not UNSET:
            field_dict["pty"] = pty

        return field_dict

    @classmethod
    def from_dict(cls: type[T], src_dict: Mapping[str, Any]) -> T:
        from ..models.pty_size import PtySize
        from ..models.start_process_request_env import StartProcessRequestEnv

        d = dict(src_dict)
        command = d.pop("command")

        args = cast(list[str], d.pop("args", UNSET))

        cwd = d.pop("cwd", UNSET)

        _env = d.pop("env", UNSET)
        env: StartProcessRequestEnv | Unset
        if isinstance(_env, Unset):
            env = UNSET
        else:
            env = StartProcessRequestEnv.from_dict(_env)

        _pty = d.pop("pty", UNSET)
        pty: PtySize | Unset
        if isinstance(_pty, Unset):
            pty = UNSET
        else:
            pty = PtySize.from_dict(_pty)

        start_process_request = cls(
            command=command,
            args=args,
            cwd=cwd,
            env=env,
            pty=pty,
        )

        start_process_request.additional_properties = d
        return start_process_request

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
